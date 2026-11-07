// Real local Postgres, no model. The shop adds and edits products; catalog edits never touch quotes, reservations or payments.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPayPalClient } from "@/lib/paypal/client";
import { completeApproval, startCheckout } from "@/services/payments/checkout";
import { decide } from "@/services/payments/decide";
import { addProduct, editProduct, catalogEditMessage } from "@/services/catalog/edit";
import { loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { acceptedPurchase, freshMerchant, type Merchant } from "./accepted-purchase";
import { must, serviceClient } from "./helpers";
import { T0 } from "./payments-helpers";
import { expectStockConsistentAtEnd } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);
const ctx = { now: T0, correlationId: "corr-catalog-edit" };

let fake: FakePayPal;
beforeAll(async () => {
  fake = await startFakePayPal();
});
afterAll(async () => {
  await fake.close();
});

const actorOf = (m: Merchant) => ({ userId: randomUUID(), merchantId: m.merchantId });
const productRow = async (id: string) => must(await db.from("products").select("name, category, unit_price_minor, is_food, active").eq("id", id).single());
const stockRow = async (id: string) => must(await db.from("stock").select("on_hand, reserved").eq("product_id", id).single());
const templateOf = async (m: Merchant) => (must(await db.from("business_rules").select("value").eq("merchant_id", m.merchantId).eq("key", "box_template").single()).value as { slots: Array<{ id: string; allowedSkus: string[] }> }).slots;
const auditsOf = async (entityId: string, action: string) => must(await db.from("audit_events").select("actor, data").eq("entity_id", entityId).eq("action", action));

const newProduct = { sku: "MUG-1", name: "Enamel mug", category: "drinkware", priceMinor: 900, isFood: false, onHand: 40, slotIds: ["gift"] };

describe("editProduct", () => {
  it("changes the fields asked for, writes cents, and audits the names of the fields, never the values", async () => {
    const m = await freshMerchant(db);
    const id = m.product["PEN-BLK"]!;
    const out = await editProduct(db, actorOf(m), id, { name: "Gel pen, black", category: "writing", priceMinor: 350, isFood: false, onHand: 450 }, ctx);
    expect(out).toEqual({ ok: true, value: { productId: id, changed: ["name", "category", "priceMinor", "onHand"] } }); // isFood was already false
    expect(await productRow(id)).toMatchObject({ name: "Gel pen, black", category: "writing", unit_price_minor: 350, is_food: false, active: true });
    expect(await stockRow(id)).toMatchObject({ on_hand: 450, reserved: 0 });

    const rows = await auditsOf(id, "catalog.product_edited");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toEqual({ fields: ["name", "category", "priceMinor", "onHand"] });
    expect(JSON.stringify(rows[0])).not.toMatch(/\b(350|450)\b|Gel pen/);
  });

  it("an edit that changes nothing writes nothing and audits nothing", async () => {
    const m = await freshMerchant(db);
    const id = m.product["PEN-BLK"]!;
    expect(await editProduct(db, actorOf(m), id, { name: "Black gel pen", priceMinor: 300, onHand: 500 }, ctx)).toEqual({ ok: true, value: { productId: id, changed: [] } });
    expect(await auditsOf(id, "catalog.product_edited")).toHaveLength(0);
  });

  it("refuses bad input and unknown keys, including a changed SKU, and changes nothing", async () => {
    const m = await freshMerchant(db);
    const id = m.product["PEN-BLK"]!;
    const bad: unknown[] = [{}, { sku: "OTHER" }, { name: "x", merchantId: randomUUID() }, { reserved: 0 }, { priceMinor: 1.5 }, { priceMinor: -1 }, { priceMinor: "300" }, { name: "" }, { onHand: -1 }, { onHand: 1.2 }, null, "name"];
    for (const patch of bad) expect(await editProduct(db, actorOf(m), id, patch, ctx), JSON.stringify(patch)).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(await editProduct(db, actorOf(m), "not-an-id", { name: "x" }, ctx)).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(await productRow(id)).toMatchObject({ name: "Black gel pen", unit_price_minor: 300 });
    expect((await db.from("products").select("sku").eq("id", id).single()).data!.sku).toBe("PEN-BLK");
  });

  it("another shop's product is not found, and so is one that does not exist", async () => {
    const mine = await freshMerchant(db);
    const theirs = await freshMerchant(db);
    const id = theirs.product["PEN-BLK"]!;
    expect(await editProduct(db, actorOf(mine), id, { priceMinor: 1 }, ctx)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await editProduct(db, actorOf(mine), randomUUID(), { priceMinor: 1 }, ctx)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await productRow(id)).toMatchObject({ unit_price_minor: 300 });
  });

  it("will not switch off the last active product of a part of the box, but can when another is on sale, and can switch it back on", async () => {
    const m = await freshMerchant(db);
    const refused = await editProduct(db, actorOf(m), m.product["NOTEBOOK-A5"]!, { active: false }, ctx);
    expect(refused).toEqual({ ok: false, code: "LAST_IN_SLOT", detail: "Notebook" });
    expect((await productRow(m.product["NOTEBOOK-A5"]!)).active).toBe(true);

    // The gift part has three products: two can go, the third cannot.
    expect(await editProduct(db, actorOf(m), m.product["BOTTLE-STEEL"]!, { active: false }, ctx)).toMatchObject({ ok: true });
    expect(await editProduct(db, actorOf(m), m.product["TRUFFLES-BOX"]!, { active: false }, ctx)).toMatchObject({ ok: true });
    expect(await editProduct(db, actorOf(m), m.product["ORGANIZER-DESK"]!, { active: false }, ctx)).toEqual({ ok: false, code: "LAST_IN_SLOT", detail: "Gift item" });
    expect(await editProduct(db, actorOf(m), m.product["BOTTLE-STEEL"]!, { active: true }, ctx)).toMatchObject({ ok: true });
    expect((await productRow(m.product["BOTTLE-STEEL"]!)).active).toBe(true);
  });

  it("will not take stock below what customers hold, and a refused edit changes nothing else", async () => {
    const m = await freshMerchant(db);
    const id = m.product["PEN-BLK"]!;
    must(await db.from("stock").update({ reserved: 30 }).eq("product_id", id));
    const out = await editProduct(db, actorOf(m), id, { name: "Renamed", onHand: 29 }, ctx);
    expect(out).toEqual({ ok: false, code: "STOCK_HELD", detail: "30" });
    expect(await productRow(id)).toMatchObject({ name: "Black gel pen" });
    expect(await stockRow(id)).toMatchObject({ on_hand: 500, reserved: 30 });
    expect(catalogEditMessage("STOCK_HELD", "30")).toContain("30");

    expect(await editProduct(db, actorOf(m), id, { onHand: 30 }, ctx)).toMatchObject({ ok: true });
    expect(await stockRow(id)).toMatchObject({ on_hand: 30, reserved: 30 });
    must(await db.from("stock").update({ reserved: 0 }).eq("product_id", id));
  });

  it("stock never goes below what is held, however many edits run at once", async () => {
    const m = await freshMerchant(db);
    const id = m.product["PEN-BLK"]!;
    must(await db.from("stock").update({ on_hand: 20, reserved: 10 }).eq("product_id", id));
    const values = [0, 3, 5, 9, 10, 12, 15, 4, 2, 11, 1, 20];
    const results = await Promise.all(values.map((onHand) => editProduct(db, actorOf(m), id, { onHand }, ctx)));
    for (const [i, r] of results.entries()) {
      if (values[i]! < 10) expect(r, `onHand ${values[i]}`).toMatchObject({ ok: false, code: "STOCK_HELD" });
    }
    const after = await stockRow(id);
    expect(after.on_hand).toBeGreaterThanOrEqual(after.reserved);
    expect(after.reserved).toBe(10);
    must(await db.from("stock").update({ reserved: 0 }).eq("product_id", id));
  });

  it("a price edit, a deactivation and a stock edit leave the published and the accepted quote as they were, and the purchase still goes through", async () => {
    const m = await freshMerchant(db);
    const p = await acceptedPurchase(db, m); // 30 boxes with the organizer: $1,080.00, accepted, stock held
    const quoteBefore = must(await db.from("quote_versions").select("status, lines, total_minor, quote_hash").eq("id", p.quoteId).single());
    expect((await stockRow(m.product["ORGANIZER-DESK"]!)).reserved).toBe(0); // stock is held when the customer starts to pay, not at accept

    const actor = actorOf(m);
    expect(await editProduct(db, actor, m.product["ORGANIZER-DESK"]!, { priceMinor: 9900, name: "Deluxe organizer" }, ctx)).toMatchObject({ ok: true });
    expect(await editProduct(db, actor, m.product["ORGANIZER-DESK"]!, { active: false }, ctx)).toMatchObject({ ok: true }); // the bottle and truffles remain
    expect(await editProduct(db, actor, m.product["ORGANIZER-DESK"]!, { onHand: 30 }, ctx)).toMatchObject({ ok: true }); // exactly what is held

    expect(must(await db.from("quote_versions").select("status, lines, total_minor, quote_hash").eq("id", p.quoteId).single())).toEqual(quoteBefore);
    expect(quoteBefore.total_minor).toBe(108_000);

    // The customer still pays and the shop still accepts, on the price that was agreed.
    const paypal = createPayPalClient({ env: "sandbox", clientId: "test-client", clientSecret: "test-secret-0000000000", baseUrl: fake.url, timeoutMs: 400 });
    const deps = { paypal, evidence: "mocked" as const };
    const started = await startCheckout(db, deps, p.who, p.purchaseId, { returnUrl: "http://localhost:3100/o/TOKEN/return" }, ctx);
    if (!started.ok) throw new Error(`startCheckout: ${started.code}`);
    expect((await stockRow(m.product["ORGANIZER-DESK"]!)).reserved).toBe(30); // the hold worked although the product is switched off now
    expect(await editProduct(db, actor, m.product["ORGANIZER-DESK"]!, { onHand: 29 }, ctx)).toMatchObject({ ok: false, code: "STOCK_HELD" });
    const orderId = must(await db.from("payment_attempts").select("paypal_order_id").eq("purchase_id", p.purchaseId).single()).paypal_order_id as string;
    fake.approve(orderId);
    expect(await completeApproval(db, deps, p.who, orderId, ctx)).toMatchObject({ ok: true });
    const decided = await decide(db, deps, { kind: "merchant", userId: actor.userId, merchantId: m.merchantId }, p.purchaseId, "accepted", { confirmedConditions: [] }, ctx);
    expect(decided).toMatchObject({ ok: true });
    expect(must(await db.from("payment_attempts").select("state").eq("purchase_id", p.purchaseId).single()).state).toBe("CAPTURED");
  });
});

describe("addProduct", () => {
  it("adds an active product with its stock, places it in the parts asked for, and audits", async () => {
    const m = await freshMerchant(db);
    const out = await addProduct(db, actorOf(m), newProduct, ctx);
    if (!out.ok) throw new Error(out.code);
    const id = out.value.productId;
    expect(await productRow(id)).toMatchObject({ name: "Enamel mug", category: "drinkware", unit_price_minor: 900, is_food: false, active: true });
    expect(await stockRow(id)).toEqual({ on_hand: 40, reserved: 0 });

    const slots = await templateOf(m);
    expect(slots.find((s) => s.id === "gift")!.allowedSkus).toEqual(["BOTTLE-STEEL", "ORGANIZER-DESK", "TRUFFLES-BOX", "MUG-1"]);
    expect(slots.find((s) => s.id === "pen")!.allowedSkus).toEqual(["PEN-BLK"]);

    const snapshot = await loadCatalogSnapshot(db, m.merchantId); // the engine's own loader accepts the new template
    expect(snapshot.catalog.products.find((p) => p.sku === "MUG-1")).toMatchObject({ active: true });
    expect(snapshot.stock[id]).toBe(40);

    const rows = await auditsOf(id, "catalog.product_added");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toMatch(/\b900\b|Enamel/);
  });

  it("can place a product in several parts", async () => {
    const m = await freshMerchant(db);
    const out = await addProduct(db, actorOf(m), { ...newProduct, sku: "MULTI", slotIds: ["gift", "pen"] }, ctx);
    expect(out.ok).toBe(true);
    const slots = await templateOf(m);
    expect(slots.filter((s) => s.allowedSkus.includes("MULTI")).map((s) => s.id).sort()).toEqual(["gift", "pen"]);
  });

  it("refuses bad input, no part, an unknown part and a SKU already in use, and creates nothing", async () => {
    const m = await freshMerchant(db);
    const count = async () => must(await db.from("products").select("id").eq("merchant_id", m.merchantId)).length;
    const before = await count();
    const templateBefore = JSON.stringify(await templateOf(m));

    for (const input of [{ ...newProduct, sku: "has space" }, { ...newProduct, priceMinor: 1.5 }, { ...newProduct, slotIds: [] }, { ...newProduct, merchantId: randomUUID() }, { ...newProduct, active: false }, null]) {
      expect(await addProduct(db, actorOf(m), input, ctx), JSON.stringify(input)).toEqual({ ok: false, code: "INVALID_INPUT" });
    }
    expect(await addProduct(db, actorOf(m), { ...newProduct, slotIds: ["nowhere"] }, ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT", detail: "UNKNOWN_SLOT" });
    expect(await addProduct(db, actorOf(m), { ...newProduct, sku: "PEN-BLK" }, ctx)).toEqual({ ok: false, code: "DUPLICATE_SKU" });
    expect(await count()).toBe(before);
    expect(JSON.stringify(await templateOf(m))).toBe(templateBefore);
  });

  it("two shops can use the same code; a shop cannot add to another shop's catalog", async () => {
    const a = await freshMerchant(db);
    const b = await freshMerchant(db);
    expect((await addProduct(db, actorOf(a), newProduct, ctx)).ok).toBe(true);
    expect((await addProduct(db, actorOf(b), newProduct, ctx)).ok).toBe(true);
    expect((await templateOf(a)).find((s) => s.id === "gift")!.allowedSkus.filter((s) => s === "MUG-1")).toHaveLength(1);
    expect((await templateOf(b)).find((s) => s.id === "gift")!.allowedSkus.filter((s) => s === "MUG-1")).toHaveLength(1);
  });

  it("the same code added twice at once makes one product", async () => {
    const m = await freshMerchant(db);
    const results = await Promise.all([addProduct(db, actorOf(m), newProduct, ctx), addProduct(db, actorOf(m), newProduct, ctx)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, code: "DUPLICATE_SKU" });
    expect(must(await db.from("products").select("id").eq("merchant_id", m.merchantId).eq("sku", "MUG-1"))).toHaveLength(1);
  });

  it("two different products added at once both end up in the template", async () => {
    const m = await freshMerchant(db);
    const results = await Promise.all([addProduct(db, actorOf(m), { ...newProduct, sku: "P-ONE" }, ctx), addProduct(db, actorOf(m), { ...newProduct, sku: "P-TWO" }, ctx)]);
    expect(results.every((r) => r.ok)).toBe(true);
    const gift = (await templateOf(m)).find((s) => s.id === "gift")!.allowedSkus;
    expect(gift).toEqual(expect.arrayContaining(["P-ONE", "P-TWO"]));
  });

  it("a failure after the product is inserted but before the template is written leaves an unsellable product and an unchanged template", async () => {
    const m = await freshMerchant(db);
    const templateBefore = JSON.stringify(await templateOf(m));
    const failing = {
      from: (table: string) => {
        const real = db.from(table);
        return table === "business_rules" ? { select: (...args: Parameters<typeof real.select>) => real.select(...args), update: () => { throw new Error("simulated failure writing the template"); } } : real;
      },
    } as unknown as SupabaseClient;

    await expect(addProduct(failing, actorOf(m), newProduct, ctx)).rejects.toThrow(/simulated failure/);

    const product = must(await db.from("products").select("id, active").eq("merchant_id", m.merchantId).eq("sku", "MUG-1").single());
    expect(await stockRow(product.id as string)).toMatchObject({ on_hand: 40 });
    expect(JSON.stringify(await templateOf(m))).toBe(templateBefore); // the template never names a product that is not set up
    const snapshot = await loadCatalogSnapshot(db, m.merchantId);
    expect(snapshot.catalog.slots.flatMap((s) => s.allowedSkus)).not.toContain("MUG-1"); // in no box, so nothing can be sold
    expect(await auditsOf(product.id as string, "catalog.product_added")).toHaveLength(0);
  });

  it("a new product appears in the quote builder's choices for its part of the box", async () => {
    const m = await freshMerchant(db);
    await addProduct(db, actorOf(m), newProduct, ctx);
    const { quoteBuilderView } = await import("@/services/intake/merchant-quote");
    const inquiry = must(await db.from("inquiries").insert({ merchant_id: m.merchantId, status: "REVIEW_REQUIRED" }).select("id").single()).id as string;
    const view = await quoteBuilderView(db, m.merchantId, inquiry);
    expect(view!.slots.find((s) => s.id === "gift")!.products.map((p) => p.name)).toContain("Enamel mug");
  });
});
