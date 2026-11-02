import { describe, expect, it } from "vitest";
import { validateConfiguration } from "@/domain/catalog/validate";
import type { Blocker, Catalog, Slot, ValidationInput } from "@/domain/catalog/types";
import { cents } from "@/lib/money";
import { demoCatalog, demoInput, demoStock, product, withGift } from "./fixtures";

function blockersOf(i: ValidationInput): Blocker[] {
  const r = validateConfiguration(i);
  if (r.ok) throw new Error("expected blocked");
  return r.blockers;
}

describe("INSUFFICIENT_STOCK", () => {
  it("reports needed and available (slot quantity x box count)", () => {
    const i = demoInput({ configuration: { boxCount: 30, selections: withGift("BOT-01") } });
    expect(blockersOf(i)).toEqual([{ code: "INSUFFICIENT_STOCK", sku: "BOT-01", needed: 30, available: 24 }]);
  });

  it("allows needing exactly what is available", () => {
    expect(validateConfiguration(demoInput({ configuration: { boxCount: 24, selections: withGift("BOT-01") } })).ok).toBe(true);
    expect(blockersOf(demoInput({ configuration: { boxCount: 25, selections: withGift("BOT-01") } }))).toHaveLength(1);
  });

  it("multiplies by slot quantity", () => {
    const slots: Slot[] = [{ id: "pen", label: "Pen", quantity: 3, allowedSkus: ["PN-01"] }];
    const catalog: Catalog = { ...demoCatalog, slots };
    const i = demoInput({
      catalog,
      configuration: { boxCount: 10, selections: { pen: "PN-01" } },
      stock: { ...demoStock, "id-PN-01": 29 },
      requirements: { noFood: false, logoRequired: false },
    });
    expect(blockersOf(i)).toEqual([{ code: "INSUFFICIENT_STOCK", sku: "PN-01", needed: 30, available: 29 }]);
  });

  it("sums per product across slots: a product used in two slots counts twice", () => {
    const slots: Slot[] = [
      { id: "a", label: "A", quantity: 1, allowedSkus: ["PN-01"] },
      { id: "b", label: "B", quantity: 2, allowedSkus: ["PN-01"] },
    ];
    const base = {
      catalog: { ...demoCatalog, slots },
      configuration: { boxCount: 10, selections: { a: "PN-01", b: "PN-01" } },
      requirements: { noFood: false, logoRequired: false },
    };
    expect(blockersOf(demoInput({ ...base, stock: { "id-PN-01": 29 } }))).toEqual([
      { code: "INSUFFICIENT_STOCK", sku: "PN-01", needed: 30, available: 29 },
    ]);
    expect(validateConfiguration(demoInput({ ...base, stock: { "id-PN-01": 30 } })).ok).toBe(true);
  });

  it("treats a product with no stock entry as zero available", () => {
    const stock = { ...demoStock };
    delete stock["id-PN-01"];
    expect(blockersOf(demoInput({ stock }))).toEqual([{ code: "INSUFFICIENT_STOCK", sku: "PN-01", needed: 20, available: 0 }]);
  });

  it("reports each short product once, in slot order", () => {
    const stock = { ...demoStock, "id-NB-01": 1, "id-PKG-01": 2 };
    expect(blockersOf(demoInput({ stock })).map((b) => (b.code === "INSUFFICIENT_STOCK" ? b.sku : b.code))).toEqual([
      "NB-01",
      "PKG-01",
    ]);
  });

  it("is not checked for an invalid box count", () => {
    expect(blockersOf(demoInput({ configuration: { boxCount: 0, selections: withGift("BOT-01") } }))).toEqual([
      { code: "INVALID_QUANTITY", boxCount: 0 },
    ]);
  });
});

describe("OVER_BUDGET", () => {
  const max = (m: number) => ({ noFood: true, logoRequired: true, maxPricePerBoxMinor: cents(m) });

  it("equal to the maximum is valid; one cent over is blocked", () => {
    expect(validateConfiguration(demoInput({ requirements: max(3500) })).ok).toBe(true);
    expect(blockersOf(demoInput({ requirements: max(3499) }))).toEqual([
      { code: "OVER_BUDGET", perBoxMinor: 3500, maxMinor: 3499 },
    ]);
  });

  it("is not checked when no maximum is given", () => {
    expect(validateConfiguration(demoInput({ requirements: { noFood: true, logoRequired: true } })).ok).toBe(true);
  });

  it("is not checked while the box has no price yet (unknown product)", () => {
    const selections = { ...withGift("BOT-01"), pen: "GHOST" };
    const codes = blockersOf(demoInput({ requirements: max(1), configuration: { boxCount: 20, selections } })).map((b) => b.code);
    expect(codes).toEqual(["UNKNOWN_PRODUCT"]);
  });

  it("is still reported next to a product blocker when every slot resolves to a known product", () => {
    const products = [...demoCatalog.products, product("OLD-01", "Retired", 5000, { active: false })];
    const slots = demoCatalog.slots.map((s) => (s.id === "pen" ? { ...s, allowedSkus: ["PN-01", "OLD-01"] } : s));
    const i = demoInput({
      catalog: { ...demoCatalog, products, slots },
      configuration: { boxCount: 1, selections: { ...withGift("BOT-01"), pen: "OLD-01" } },
      stock: { ...demoStock, "id-OLD-01": 5 },
    });
    expect(blockersOf(i).map((b) => b.code)).toEqual(["INACTIVE_PRODUCT", "OVER_BUDGET"]);
  });
});

describe("fixed blocker order", () => {
  it("returns structure, product, constraint, stock, price, date together, and no price", () => {
    const products = [...demoCatalog.products, product("OLD-01", "Retired", 5000, { active: false })];
    const slots = demoCatalog.slots.map((s) => (s.id === "pen" ? { ...s, allowedSkus: ["PN-01", "OLD-01"] } : s));
    const i = demoInput({
      catalog: { ...demoCatalog, products, slots, rules: { productionLeadDays: 30 } },
      configuration: { boxCount: 30, selections: { ...withGift("TRF-01"), pen: "OLD-01", extra: "NB-01" } },
      stock: { ...demoStock, "id-TRF-01": 5, "id-OLD-01": 100 },
      requirements: { noFood: true, logoRequired: true, maxPricePerBoxMinor: cents(1000), requestedPickupDate: "2026-11-05" },
    });
    const r = validateConfiguration(i);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r).not.toHaveProperty("priced");
    expect(r.blockers.map((b) => b.code)).toEqual([
      "UNKNOWN_SLOT", // structure
      "INACTIVE_PRODUCT", // product
      "FOOD_NOT_ALLOWED", // constraint
      "INSUFFICIENT_STOCK", // stock
      "OVER_BUDGET", // price
      "UNSUPPORTED_DATE", // date
    ]);
  });
});
