// Real local Postgres. The run starts from an empty schema (global setup), so this file seeds the demo fixtures itself.
import { beforeAll, describe, expect, it } from "vitest";
import { validateConfiguration } from "@/domain/catalog";
import { CatalogLoadError, loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { boxTemplate, businessRules, merchant, MERCHANT_ID, PRODUCT_IDS, products, stock } from "../../supabase/seed/fixtures";
import { must, serviceClient, unique } from "./helpers";

const db = serviceClient();

async function seedDemo() {
  must(await db.from("merchants").upsert(merchant, { onConflict: "id" }), "merchant");
  must(await db.from("products").upsert(products, { onConflict: "id" }), "products");
  must(await db.from("stock").upsert(stock, { onConflict: "product_id" }), "stock");
  must(await db.from("business_rules").upsert(businessRules, { onConflict: "merchant_id,key" }), "rules");
}

async function setRule(merchantId: string, key: string, value: unknown) {
  must(await db.from("business_rules").upsert({ merchant_id: merchantId, key, value }, { onConflict: "merchant_id,key" }), key);
}

async function newMerchant(): Promise<string> {
  const row = must(await db.from("merchants").insert({ slug: unique("cat"), name: "Other merchant" }).select("id").single(), "merchant");
  return row.id as string;
}

beforeAll(seedDemo);

describe("loadCatalogSnapshot against Postgres", () => {
  it("returns the seeded catalog, template and rules", async () => {
    const { catalog, stock: available } = await loadCatalogSnapshot(db, MERCHANT_ID);
    expect(catalog.products).toHaveLength(7);
    expect(catalog.slots.map((s) => s.id)).toEqual(["notebook", "pen", "gift", "card", "packaging"]);
    expect(catalog.slots[2]?.allowedSkus).toEqual(["BOTTLE-STEEL", "ORGANIZER-DESK", "TRUFFLES-BOX"]);
    expect(catalog.slots[3]?.customization).toBe("logo");
    expect(catalog.rules).toEqual({ productionLeadDays: 7 });
    const bottle = catalog.products.find((p) => p.sku === "BOTTLE-STEEL")!;
    expect(bottle).toMatchObject({ id: PRODUCT_IDS.bottle, unitPriceMinor: 1300, isFood: false, active: true });
    expect(available[PRODUCT_IDS.bottle]).toBe(24);
  });

  it("derives available = on_hand - reserved", async () => {
    must(await db.from("stock").update({ reserved: 4 }).eq("product_id", PRODUCT_IDS.bottle), "reserve");
    try {
      const { stock: available } = await loadCatalogSnapshot(db, MERCHANT_ID);
      expect(available[PRODUCT_IDS.bottle]).toBe(20);
    } finally {
      must(await db.from("stock").update({ reserved: 0 }).eq("product_id", PRODUCT_IDS.bottle), "unreserve");
    }
  });

  it("feeds the engine: 30 boxes with the bottle is blocked by the real stock of 24", async () => {
    const { catalog, stock: available } = await loadCatalogSnapshot(db, MERCHANT_ID);
    const result = validateConfiguration({
      configuration: {
        boxCount: 30,
        selections: { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "BOTTLE-STEEL", card: "CARD-BRANDED", packaging: "PACK-BOX" },
      },
      catalog,
      requirements: { noFood: true, logoRequired: true },
      stock: available,
      today: "2026-11-02",
    });
    expect(result).toEqual({
      ok: false,
      blockers: [{ code: "INSUFFICIENT_STOCK", sku: "BOTTLE-STEEL", needed: 30, available: 24 }],
    });
  });

  it("reads the minimum order quantity when the merchant sets one, and treats a missing lead-days rule as 0", async () => {
    const id = await newMerchant();
    const product = must(
      await db.from("products").insert({ merchant_id: id, sku: "ONLY", name: "Only", category: "x", unit_price_minor: 100 }).select("id").single(),
      "product",
    );
    await setRule(id, "box_template", { slots: [{ id: "s", label: "S", quantity: 1, allowedSkus: ["ONLY"] }] });
    expect((await loadCatalogSnapshot(db, id)).catalog.rules).toEqual({ productionLeadDays: 0 });
    await setRule(id, "min_order_quantity", { quantity: 12 });
    expect((await loadCatalogSnapshot(db, id)).catalog.rules).toEqual({ productionLeadDays: 0, minOrderQuantity: 12 });
    // no stock row means nothing available
    expect((await loadCatalogSnapshot(db, id)).stock[product.id as string]).toBe(0);
  });

  it("never returns another merchant's rows", async () => {
    const id = await newMerchant();
    must(await db.from("products").insert({ merchant_id: id, sku: "THEIRS-1", name: "Theirs", category: "x", unit_price_minor: 100 }), "product");
    await setRule(id, "box_template", { slots: [{ id: "s", label: "S", quantity: 1, allowedSkus: ["THEIRS-1"] }] });
    const theirs = await loadCatalogSnapshot(db, id);
    expect(theirs.catalog.products.map((p) => p.sku)).toEqual(["THEIRS-1"]);
    const ours = await loadCatalogSnapshot(db, MERCHANT_ID);
    expect(ours.catalog.products.some((p) => p.sku === "THEIRS-1")).toBe(false);
    expect(Object.keys(ours.stock).sort()).toEqual(Object.values(PRODUCT_IDS).sort());
  });

  it("fails clearly when the template is missing", async () => {
    const id = await newMerchant();
    await expect(loadCatalogSnapshot(db, id)).rejects.toThrow(CatalogLoadError);
    await expect(loadCatalogSnapshot(db, id)).rejects.toThrow(/box_template/);
  });

  it.each([
    ["not an object", "oops"],
    ["no slots", { slots: [] }],
    ["duplicate slot ids", { slots: [{ id: "a", label: "A", quantity: 1, allowedSkus: ["ONLY"] }, { id: "a", label: "A", quantity: 1, allowedSkus: ["ONLY"] }] }],
    ["a stray price field", { slots: [{ id: "a", label: "A", quantity: 1, allowedSkus: ["ONLY"], priceMinor: 1 }] }],
    ["a SKU the merchant does not sell", { slots: [{ id: "a", label: "A", quantity: 1, allowedSkus: ["GHOST"] }] }],
  ])("fails clearly on a malformed template: %s", async (_label, value) => {
    const id = await newMerchant();
    must(await db.from("products").insert({ merchant_id: id, sku: "ONLY", name: "Only", category: "x", unit_price_minor: 100 }), "product");
    await setRule(id, "box_template", value);
    await expect(loadCatalogSnapshot(db, id)).rejects.toThrow(CatalogLoadError);
    await expect(loadCatalogSnapshot(db, id)).rejects.toThrow(/box_template/);
  });

  it("fails clearly on malformed lead-days or minimum rules", async () => {
    const id = await newMerchant();
    must(await db.from("products").insert({ merchant_id: id, sku: "ONLY", name: "Only", category: "x", unit_price_minor: 100 }), "product");
    await setRule(id, "box_template", { slots: [{ id: "s", label: "S", quantity: 1, allowedSkus: ["ONLY"] }] });
    await setRule(id, "production_lead_days", { days: -2 });
    await expect(loadCatalogSnapshot(db, id)).rejects.toThrow(/production_lead_days/);
    await setRule(id, "production_lead_days", { days: 3 });
    await setRule(id, "min_order_quantity", { quantity: 0 });
    await expect(loadCatalogSnapshot(db, id)).rejects.toThrow(/min_order_quantity/);
  });

  it("the shared seed fixture holds a valid template", () => {
    expect(businessRules.some((r) => r.key === "box_template" && r.value === boxTemplate)).toBe(true);
  });
});
