import "server-only";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { getClientEnv } from "@/lib/env-client";

/**
 * Supabase client for the signed-in merchant: uses the anon key plus the session cookie,
 * so row level security applies. Reading cookies is a runtime API: call it inside <Suspense>.
 */
export async function createSessionClient(): Promise<SupabaseClient> {
  // The Supabase client reads the clock when it is created, so it must never be built during prerender.
  await connection();
  const env = getClientEnv();
  const cookieStore = await cookies();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only. The proxy refreshes the session.
        }
      },
    },
  });
}
