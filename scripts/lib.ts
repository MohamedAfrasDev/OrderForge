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

/** The demo shop slugs `--only=` accepts, in seed order. */
export const SEED_SLUGS: string[] = shops.map((s) => s.merchant.slug);

/**
 * The value of `--only=<slug>` on the command line, or undefined when it is absent (seed every shop). It must be given once, with a value,
 * and name a demo shop: anything else throws before the database is touched, so a typo can never mean "seed everything".
 */
export function parseOnly(argv: string[]): string | undefined {
  const given = argv.filter((a) => a === "--only" || a.startsWith("--only="));
  if (given.length === 0) return undefined;
  if (given.length > 1) throw new Error("Pass --only once.");
  const value = given[0]!.startsWith("--only=") ? given[0]!.slice("--only=".length) : "";
  if (!SEED_SLUGS.includes(value)) {
    throw new Error(`--only must name a demo shop: one of ${SEED_SLUGS.join(", ")}${value ? ` (got "${value}")` : ""}.`);
  }
  return value;
}

/** How many orders exist for the shops a seed run would write to: one shop's with `--only`, otherwise all. Seeding resets stock, so any makes it unsafe. */
export async function purchaseCount(db: SupabaseClient, only?: string): Promise<number> {
  const ids = (only ? shops.filter((s) => s.merchant.slug === only) : shops).map((s) => s.merchant.id);
  const result = check("purchases", await db.from("purchases").select("id", { count: "exact", head: true }).in("merchant_id", ids));
  return result.count ?? 0;
}

/** The sign-in addresses (lowercase) of the owners of every shop except `slug`, from the database, so a login that already owns another shop is never reused or reset. */
async function otherOwnerEmails(db: SupabaseClient, slug: string): Promise<string[]> {
  const others = check("merchants", await db.from("merchants").select("owner_user_id").neq("slug", slug).not("owner_user_id", "is", null));
  const emails: string[] = [];
  for (const row of others.data ?? []) {
    const user = check("get user", await db.auth.admin.getUserById(row.owner_user_id as string));
    if (user.data.user?.email) emails.push(user.data.user.email.toLowerCase());
  }
  return emails;
}

/**
 * Seeds the demo shops, each with its own owner login. `env` is where the owners' logins are read from (the process environment by default).
 * With `options.only` it creates or completes just that one shop and its owner: the other shops' rows, stock and logins are not read for writing
 * and not changed, and only that shop's login variables are needed.
 */
export async function runSeed(db: SupabaseClient, env: Env = process.env, options: { only?: string } = {}): Promise<void> {
  const chosen = options.only === undefined ? shops : shops.filter((s) => s.merchant.slug === options.only);
  if (chosen.length === 0) throw new Error(`Unknown demo shop "${options.only}". Choose one of ${SEED_SLUGS.join(", ")}.`);

  if (options.only === undefined) {
    // One login owning both shops would make the second shop's isolation meaningless, so refuse it before anything is written.
    const emails = shops.map((s) => (env[s.owner.emailVar] ?? "").toLowerCase());
    if (new Set(emails).size !== emails.length) throw new Error("Each demo shop needs a different owner: the owner emails must be different.");
  }

  for (const shop of chosen) {
    if (options.only !== undefined) {
      // Checked before the login is created or reset: an address that already owns another shop must not have its password changed here.
      const wanted = (env[shop.owner.emailVar] ?? "").toLowerCase();
      const taken = new Set([...shops.filter((s) => s !== shop).map((s) => (env[s.owner.emailVar] ?? "").toLowerCase()), ...(await otherOwnerEmails(db, shop.merchant.slug))]);
      if (wanted && taken.has(wanted)) throw new Error("Each demo shop needs a different owner: the owner emails must be different.");
    }
    const userId = await ensureMerchantUser(db, env, shop.owner.emailVar, shop.owner.passwordVar);
    check("merchants", await db.from("merchants").upsert({ ...shop.merchant, owner_user_id: userId }, { onConflict: "id" }));
    check("products", await db.from("products").upsert(shop.products, { onConflict: "id" }));
    check("stock", await db.from("stock").upsert(shop.stock, { onConflict: "product_id" }));
    check("business_rules", await db.from("business_rules").upsert(shop.rules, { onConflict: "merchant_id,key" }));
    console.log(`Seeded ${shop.merchant.slug} (${shop.merchant.id}): ${shop.products.length} products, ${shop.rules.length} rules.`);
  }
}
