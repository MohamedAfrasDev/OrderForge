// Shared helpers for the seed and demo-reset scripts. Run with Node's --env-file and
// --experimental-strip-types (see package.json), so keep this file to erasable TypeScript.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { businessRules, merchant, MERCHANT_ID, products, stock } from "../supabase/seed/fixtures.ts";

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function adminClient(): SupabaseClient {
  if (process.env.SANDBOX_MODE !== "true") {
    throw new Error("Refusing to run: SANDBOX_MODE must be exactly 'true'.");
  }
  const url = need("NEXT_PUBLIC_SUPABASE_URL");
  const host = new URL(url).hostname;
  // These scripts write (and demo-reset wipes) data. Against anything but a local stack,
  // the caller must name the host on the command line, so a stray .env cannot trigger it.
  if (!LOCAL_HOSTS.has(host) && !process.argv.includes(`--confirm-host=${host}`)) {
    throw new Error(
      `Refusing to run against remote project ${host}. Re-run with --confirm-host=${host} if that is intended.`,
    );
  }
  return createClient(url, need("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function check<R extends { error: { message: string } | null }>(label: string, result: R): R {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result;
}

async function ensureMerchantUser(db: SupabaseClient): Promise<string> {
  const email = need("DEMO_MERCHANT_EMAIL");
  const password = need("DEMO_MERCHANT_PASSWORD");
  if (password.length < 12 || password.startsWith("replace-with")) {
    throw new Error("DEMO_MERCHANT_PASSWORD must be set to a real value of at least 12 characters.");
  }

  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.data.user) return created.data.user.id;

  // Already exists: find it and reset the password so the .env value always works.
  const list = check("list users", await db.auth.admin.listUsers({ perPage: 1000 }));
  const existing = list.data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!existing) throw new Error(`create user: ${created.error?.message ?? "unknown error"}`);
  check("update user", await db.auth.admin.updateUserById(existing.id, { password, email_confirm: true }));
  return existing.id;
}

export async function runSeed(db: SupabaseClient): Promise<void> {
  const userId = await ensureMerchantUser(db);

  check("merchants", await db.from("merchants").upsert({ ...merchant, owner_user_id: userId }, { onConflict: "id" }));
  check("products", await db.from("products").upsert(products, { onConflict: "id" }));
  check("stock", await db.from("stock").upsert(stock, { onConflict: "product_id" }));
  check("business_rules", await db.from("business_rules").upsert(businessRules, { onConflict: "merchant_id,key" }));

  console.log(`Seeded merchant ${MERCHANT_ID}: ${products.length} products, ${businessRules.length} rules.`);
}
