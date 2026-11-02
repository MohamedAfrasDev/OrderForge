import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// Creates throwaway accounts in the LOCAL Supabase stack for the sign-in tests.
// Skipped (and the tests skip too) when no local stack is running.
export default async function globalSetup() {
  if (process.env.E2E_LOCAL_SUPABASE !== "1") return;

  const url = process.env.E2E_SUPABASE_URL!;
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to create E2E accounts on non-local host ${host}`);
  }

  const db = createClient(url, process.env.E2E_SUPABASE_SERVICE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const tag = randomBytes(4).toString("hex");

  async function createUser(label: string) {
    const email = `e2e-${label}-${tag}@test.invalid`;
    const password = randomUUID();
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser(${label}): ${error?.message}`);
    return { id: data.user.id, email, password };
  }

  const merchantUser = await createUser("merchant");
  const outsider = await createUser("outsider");

  const merchantName = `E2E Merchant ${tag}`;
  const { error } = await db
    .from("merchants")
    .insert({ slug: `e2e-${tag}`, name: merchantName, owner_user_id: merchantUser.id });
  if (error) throw new Error(`merchant insert: ${error.message}`);

  process.env.E2E_MERCHANT_EMAIL = merchantUser.email;
  process.env.E2E_MERCHANT_PASSWORD = merchantUser.password;
  process.env.E2E_MERCHANT_NAME = merchantName;
  process.env.E2E_OUTSIDER_EMAIL = outsider.email;
  process.env.E2E_OUTSIDER_PASSWORD = outsider.password;
}
