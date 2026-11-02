import { describe, expect, it } from "vitest";
import { catalogForModel } from "@/domain/catalog/model-view";
import { demoCatalog, product } from "./fixtures";

describe("catalogForModel", () => {
  const view = catalogForModel(demoCatalog);

  it("lists names, SKUs, categories, food flags and prices", () => {
    expect(view.products).toContainEqual({
      sku: "TRF-01",
      name: "Chocolate truffles",
      category: "food",
      isFood: true,
      unitPriceMinor: 900,
    });
    expect(view.products).toHaveLength(7);
  });

  it("lists the slots with their allowed SKUs and the logo marker", () => {
    expect(view.slots.map((s) => s.id)).toEqual(["notebook", "pen", "gift", "card", "packaging"]);
    expect(view.slots[2]).toEqual({ id: "gift", label: "Gift item", quantity: 1, allowedSkus: ["BOT-01", "ORG-01", "TRF-01"] });
    expect(view.slots[3]).toMatchObject({ id: "card", customization: "logo" });
  });

  it("carries the merchant rules the model may explain", () => {
    expect(view.rules).toEqual({ productionLeadDays: 0 });
    expect(catalogForModel({ ...demoCatalog, rules: { productionLeadDays: 4, minOrderQuantity: 12 } }).rules).toEqual({
      productionLeadDays: 4,
      minOrderQuantity: 12,
    });
  });

  it("never exposes internal ids or stock counts", () => {
    const text = JSON.stringify(view);
    for (const p of demoCatalog.products) expect(text).not.toContain(p.id);
    expect(text).not.toMatch(/"id":"id-|stock|available|onHand|reserved|\bactive\b/i);
    for (const p of view.products) expect(Object.keys(p).sort()).toEqual(["category", "isFood", "name", "sku", "unitPriceMinor"]);
  });

  it("leaves out inactive products, including from slot allowed lists", () => {
    const withOld = {
      ...demoCatalog,
      products: [...demoCatalog.products, product("OLD-01", "Retired", 900, { active: false })],
      slots: demoCatalog.slots.map((s) => (s.id === "gift" ? { ...s, allowedSkus: [...s.allowedSkus, "OLD-01"] } : s)),
    };
    const v = catalogForModel(withOld);
    expect(v.products.some((p) => p.sku === "OLD-01")).toBe(false);
    expect(v.slots[2]?.allowedSkus).not.toContain("OLD-01");
  });

  it("does not mutate its input and is deterministic", () => {
    const before = JSON.stringify(demoCatalog);
    expect(catalogForModel(demoCatalog)).toEqual(catalogForModel(demoCatalog));
    expect(JSON.stringify(demoCatalog)).toBe(before);
  });
});
