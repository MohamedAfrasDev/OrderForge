// The seed's --only option on a real local Postgres: it adds the second shop to a site that already runs the first, with orders in it,
// without touching the first shop's rows, stock, orders or login. It is idempotent and refuses what it cannot do safely.
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purchaseCount, runSeed } from "../../scripts/lib.ts";
import { MERCHANT2_ID, MERCHANT_ID, businessRules2, products, products2 } from "../../supabase/seed/fixtures";
import { acceptedPurchase } from "./accepted-purchase";
import { must, localStack, serviceClient } from "./helpers";

const db = serviceClient();
const tag = randomBytes(4).toString("hex");
const first = { DEMO_MERCHANT_EMAIL: `only-a-${tag}@seed.test`, DEMO_MERCHANT_PASSWORD: `Password-${tag}-aaaa` };
const second = { DEMO_MERCHANT2_EMAIL: `only-b-${tag}@seed.test`, DEMO_MERCHANT2_PASSWORD: `Password-${tag}-bbbb` };
const GIFT = "demo-gift-boxes";
const KITS = "demo-event-kits";

async function cleanup() {
  must(await db.rpc("demo_reset"), "demo_reset");
  const list = await db.auth.admin.listUsers({ perPage: 1000 });
  if (list.error) throw new Error(`list users: ${list.error.message}`);
  for (const u of list.data.users) if (u.email?.endsWith(`-${tag}@seed.test`)) await db.auth.admin.deleteUser(u.id);
}

/** Everything the first shop owns that a seed could change, so "untouched" is a comparison and not a belief. */
async function firstShopState() {
  const ids = products.map((p) => p.id);
  return {
    merchant: must(await db.from("merchants").select("*").eq("id", MERCHANT_ID).single(), "merchant"),
    products: must(await db.from("products").select("*").eq("merchant_id", MERCHANT_ID).order("id"), "products"),
    stock: must(await db.from("stock").select("*").in("product_id", ids).order("product_id"), "stock"),
    rules: must(await db.from("business_rules").select("*").eq("merchant_id", MERCHANT_ID).order("key"), "rules"),
    purchases: must(await db.from("purchases").select("id").eq("merchant_id", MERCHANT_ID).order("id"), "purchases"),
  };
}

const secondShopRows = async () => ({
  merchant: must(await db.from("merchants").select("id, owner_user_id").eq("id", MERCHANT2_ID), "m2"),
  products: must(await db.from("products").select("id").eq("merchant_id", MERCHANT2_ID), "p2"),
  stock: must(await db.from("stock").select("product_id").in("product_id", products2.map((p) => p.id)), "s2"),
  rules: must(await db.from("business_rules").select("key").eq("merchant_id", MERCHANT2_ID), "r2"),
});

beforeAll(async () => {
  await cleanup();
  // The site as it is today: only the first shop, with an accepted order holding some of its stock.
  await runSeed(db, { ...first, ...second }, { only: GIFT });
  const sku = new Map(products.map((p) => [p.sku, p.id]));
  await acceptedPurchase(db, { merchantId: MERCHANT_ID, product: Object.fromEntries(sku) }, { boxCount: 5 });
  // Live stock that a re-seed of this shop would wrongly put back to the fixture levels: 3 steel bottles are held and 2 have been used up.
  must(await db.from("stock").update({ on_hand: 22, reserved: 3 }).eq("product_id", sku.get("BOTTLE-STEEL")!), "live stock");
});
afterAll(cleanup);

describe("seed --only", () => {
  it("starts from a site with only the first shop and an order in it, live stock", async () => {
    expect((await secondShopRows()).merchant).toHaveLength(0);
    expect(await purchaseCount(db)).toBe(1);
    expect(await purchaseCount(db, GIFT)).toBe(1);
    expect(await purchaseCount(db, KITS)).toBe(0); // the second shop has no orders, so seeding it is safe even though the site has one
    const bottle = (await firstShopState()).stock.find((s) => s.product_id === products.find((p) => p.sku === "BOTTLE-STEEL")!.id);
    expect(bottle).toMatchObject({ on_hand: 22, reserved: 3 });
  });

  it("adds the second shop, its owner and its rows, and changes nothing of the first shop: rows, held stock, order, login", async () => {
    const before = await firstShopState();
    // Only the second shop's login variables are given: the first shop's are not needed.
    await runSeed(db, second, { only: KITS });
    const added = await secondShopRows();
    expect(added.merchant).toHaveLength(1);
    expect(added.merchant[0]!.owner_user_id).toBeTruthy();
    expect(added.products).toHaveLength(products2.length);
    expect(added.stock).toHaveLength(products2.length);
    expect(added.rules.map((r) => r.key).sort()).toEqual(businessRules2.map((r) => r.key).sort());

    expect(await firstShopState()).toEqual(before);
    expect(await purchaseCount(db, GIFT)).toBe(1);

    // The first owner can still sign in with their old password.
    const stack = localStack();
    const client = createClient(stack.url, stack.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await client.auth.signInWithPassword({ email: first.DEMO_MERCHANT_EMAIL, password: first.DEMO_MERCHANT_PASSWORD })).error).toBeNull();
  });

  it("running it again changes nothing (same owner, same rows)", async () => {
    const before = await secondShopRows();
    const firstBefore = await firstShopState();
    await runSeed(db, second, { only: KITS });
    expect(await secondShopRows()).toEqual(before);
    expect(await firstShopState()).toEqual(firstBefore);
  });

  it("refuses an unknown shop and writes nothing", async () => {
    const before = must(await db.from("merchants").select("id").order("id"), "merchants");
    await expect(runSeed(db, { ...first, ...second }, { only: "no-such-shop" })).rejects.toThrow(/Unknown demo shop/);
    expect(must(await db.from("merchants").select("id").order("id"), "merchants after")).toEqual(before);
  });

  it("refuses a login that already owns the other shop, and does not reset that login's password", async () => {
    const firstBefore = await firstShopState();
    await expect(runSeed(db, { DEMO_MERCHANT2_EMAIL: first.DEMO_MERCHANT_EMAIL, DEMO_MERCHANT2_PASSWORD: `Different-${tag}-zzzz` }, { only: KITS })).rejects.toThrow(/different/i);
    const stack = localStack();
    const client = createClient(stack.url, stack.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await client.auth.signInWithPassword({ email: first.DEMO_MERCHANT_EMAIL, password: first.DEMO_MERCHANT_PASSWORD })).error).toBeNull();
    expect(await firstShopState()).toEqual(firstBefore);
  });

  it("refuses a missing or placeholder login for the shop being seeded", async () => {
    await expect(runSeed(db, { DEMO_MERCHANT2_PASSWORD: second.DEMO_MERCHANT2_PASSWORD }, { only: KITS })).rejects.toThrow(/DEMO_MERCHANT2_EMAIL/);
    await expect(runSeed(db, { ...second, DEMO_MERCHANT2_PASSWORD: "replace-with-demo-merchant-two-password" }, { only: KITS })).rejects.toThrow(/DEMO_MERCHANT2_PASSWORD/);
  });
});
