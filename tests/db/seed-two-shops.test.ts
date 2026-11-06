// The seed on a real local Postgres: two shops, two owners, idempotent, and it never mixes one shop's rows with the other's.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../../scripts/lib.ts";
import { shops } from "../../supabase/seed/fixtures";
import { must, serviceClient } from "./helpers";

const db = serviceClient();
const tag = randomBytes(4).toString("hex");
const env = {
  DEMO_MERCHANT_EMAIL: `seed-a-${tag}@seed.test`,
  DEMO_MERCHANT_PASSWORD: `Password-${tag}-aaaa`,
  DEMO_MERCHANT2_EMAIL: `seed-b-${tag}@seed.test`,
  DEMO_MERCHANT2_PASSWORD: `Password-${tag}-bbbb`,
};

async function cleanup() {
  must(await db.rpc("demo_reset"), "demo_reset");
  const list = await db.auth.admin.listUsers({ perPage: 1000 });
  if (list.error) throw new Error(`list users: ${list.error.message}`);
  for (const u of list.data.users) if (u.email?.endsWith(`-${tag}@seed.test`)) await db.auth.admin.deleteUser(u.id);
}

beforeAll(cleanup);
afterAll(cleanup);

describe("the seed with two shops", () => {
  it("creates both shops, each with its own owner, products, stock and rules", async () => {
    await runSeed(db, env);

    const merchants = must(await db.from("merchants").select("id, slug, name, owner_user_id").order("slug"), "merchants");
    expect(merchants.map((m) => m.slug)).toEqual(["demo-event-kits", "demo-gift-boxes"]);
    const owners = merchants.map((m) => m.owner_user_id);
    expect(owners.every(Boolean)).toBe(true);
    expect(new Set(owners).size).toBe(2);

    for (const shop of shops) {
      const products = must(await db.from("products").select("id").eq("merchant_id", shop.merchant.id), "products");
      expect(products).toHaveLength(shop.products.length);
      const stock = must(await db.from("stock").select("product_id, on_hand, reserved").in("product_id", shop.products.map((p) => p.id)), "stock");
      expect(stock).toHaveLength(shop.stock.length);
      const rules = must(await db.from("business_rules").select("key").eq("merchant_id", shop.merchant.id), "rules");
      expect(rules.map((r) => r.key).sort()).toEqual(shop.rules.map((r) => r.key).sort());
    }
  });

  it("running it again changes nothing (same rows, same owners)", async () => {
    const before = must(await db.from("merchants").select("id, owner_user_id").order("id"), "before");
    const productsBefore = must(await db.from("products").select("id"), "products before");
    await runSeed(db, env);
    expect(must(await db.from("merchants").select("id, owner_user_id").order("id"), "after")).toEqual(before);
    expect(must(await db.from("products").select("id"), "products after")).toHaveLength(productsBefore.length);
  });

  it("each owner sees only their own shop under row level security", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { localStack } = await import("./helpers");
    const stack = localStack();
    for (const [emailVar, passwordVar, slug] of [
      ["DEMO_MERCHANT_EMAIL", "DEMO_MERCHANT_PASSWORD", "demo-gift-boxes"],
      ["DEMO_MERCHANT2_EMAIL", "DEMO_MERCHANT2_PASSWORD", "demo-event-kits"],
    ] as const) {
      const client = createClient(stack.url, stack.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const signedIn = await client.auth.signInWithPassword({ email: env[emailVar], password: env[passwordVar] });
      expect(signedIn.error).toBeNull();
      const seen = must(await client.from("merchants").select("slug"), "merchants as owner");
      expect(seen.map((m) => m.slug)).toEqual([slug]);
    }
  });

  it("refuses an owner login that is missing, short, or still a placeholder", async () => {
    await expect(runSeed(db, { ...env, DEMO_MERCHANT2_PASSWORD: "short" })).rejects.toThrow(/DEMO_MERCHANT2_PASSWORD/);
    await expect(runSeed(db, { ...env, DEMO_MERCHANT2_PASSWORD: "replace-with-demo-merchant-two-password" })).rejects.toThrow(/DEMO_MERCHANT2_PASSWORD/);
    await expect(runSeed(db, { ...env, DEMO_MERCHANT2_EMAIL: undefined })).rejects.toThrow(/DEMO_MERCHANT2_EMAIL/);
  });

  it("the two owners are different people: one email cannot own both shops", async () => {
    await expect(runSeed(db, { ...env, DEMO_MERCHANT2_EMAIL: env.DEMO_MERCHANT_EMAIL })).rejects.toThrow(/different/i);
  });
});
