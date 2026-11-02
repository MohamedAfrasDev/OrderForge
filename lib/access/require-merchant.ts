import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { decideMerchantAccess, type MerchantAccess } from "@/lib/access/merchant";
import { createSessionClient } from "@/lib/supabase/server";

/**
 * Verifies the session with the Auth server (getUser, not just the cookie) and loads the
 * merchants this user can see under row level security. This is the real authorization check;
 * proxy.ts only does an early redirect.
 */
export async function getMerchantAccess(client?: SupabaseClient): Promise<MerchantAccess> {
  const supabase = client ?? (await createSessionClient());
  const { data } = await supabase.auth.getUser();
  if (!data.user) return decideMerchantAccess(null, []);

  const { data: merchants } = await supabase
    .from("merchants")
    .select("id, name, slug")
    .order("created_at", { ascending: true });
  return decideMerchantAccess({ id: data.user.id, email: data.user.email }, merchants ?? []);
}

/** For pages, actions and route handlers behind the merchant login. Redirects when access is denied. */
export async function requireMerchant() {
  const access = await getMerchantAccess();
  if (!access.ok) redirect("/merchant/login");
  return access;
}
