// Shared helpers for the seed and demo-reset scripts. Run with Node's --env-file and
// --experimental-strip-types (see package.json), so keep this file to erasable TypeScript.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { shops } from "../supabase/seed/fixtures.ts";

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

type Env = Record<string, string | undefined>;

async function ensureMerchantUser(db: SupabaseClient, env: Env, emailVar: string, passwordVar: string): Promise<string> {
  const email = env[emailVar];
  const password = env[passwordVar];
  if (!email) throw new Error(`Missing environment variable: ${emailVar}`);
  if (!password || password.length < 12 || password.startsWith("replace-with")) {
    throw new Error(`${passwordVar} must be set to a real value of at least 12 characters.`);
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

/** Seeds every demo shop, each with its own owner login. `env` is where the owners' logins are read from (the process environment by default). */
export async function runSeed(db: SupabaseClient, env: Env = process.env): Promise<void> {
  // One login owning both shops would make the second shop's isolation meaningless, so refuse it before anything is written.
  const emails = shops.map((s) => (env[s.owner.emailVar] ?? "").toLowerCase());
  if (new Set(emails).size !== emails.length) throw new Error("Each demo shop needs a different owner: the owner emails must be different.");

  for (const shop of shops) {
    const userId = await ensureMerchantUser(db, env, shop.owner.emailVar, shop.owner.passwordVar);
    check("merchants", await db.from("merchants").upsert({ ...shop.merchant, owner_user_id: userId }, { onConflict: "id" }));
    check("products", await db.from("products").upsert(shop.products, { onConflict: "id" }));
    check("stock", await db.from("stock").upsert(shop.stock, { onConflict: "product_id" }));
    check("business_rules", await db.from("business_rules").upsert(shop.rules, { onConflict: "merchant_id,key" }));
    console.log(`Seeded ${shop.merchant.slug} (${shop.merchant.id}): ${shop.products.length} products, ${shop.rules.length} rules.`);
  }
}
