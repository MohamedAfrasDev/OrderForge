"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getMerchantAccess } from "@/lib/access/require-merchant";
import { createSessionClient } from "@/lib/supabase/server";

export type LoginState = { error: string } | null;

const credentials = z.object({
  email: z.email(),
  password: z.string().min(1),
});

// One message for every failure, so the form never reveals which part was wrong.
const FAILED: LoginState = { error: "Invalid email or password." };

export async function signIn(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return FAILED;

  const supabase = await createSessionClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return FAILED;

  // A valid account that does not own a merchant is not allowed into the portal.
  const access = await getMerchantAccess(supabase);
  if (!access.ok) {
    await supabase.auth.signOut();
    return FAILED;
  }

  redirect("/merchant");
}
