import { describe, expect, it } from "vitest";
import { LIMITS, addProductSchema, checkDeactivation, checkNewProductSlots, checkStockChange, editProductSchema, withSkuInSlots } from "@/domain/catalog-edit";

const slots = [
  { id: "notebook", label: "Notebook", allowedSkus: ["NB"] },
  { id: "gift", label: "Gift item", allowedSkus: ["BOTTLE", "ORGANIZER"] },
];
const products = [
  { sku: "NB", active: true },
  { sku: "BOTTLE", active: true },
  { sku: "ORGANIZER", active: true },
];

describe("checkDeactivation", () => {
  it("allows switching off a product when its part of the box has another active one", () => {
    expect(checkDeactivation(slots, products, "BOTTLE")).toEqual({ ok: true });
  });
  it("refuses the last active product of a part, naming the part", () => {
    expect(checkDeactivation(slots, products, "NB")).toEqual({ ok: false, slotLabels: ["Notebook"] });
    const oneLeft = [products[0]!, { sku: "BOTTLE", active: false }, products[2]!];
    expect(checkDeactivation(slots, oneLeft, "ORGANIZER")).toEqual({ ok: false, slotLabels: ["Gift item"] });
  });
  it("names every part that would be left empty", () => {
    const both = [{ id: "a", label: "A", allowedSkus: ["X"] }, { id: "b", label: "B", allowedSkus: ["X"] }];
    expect(checkDeactivation(both, [{ sku: "X", active: true }], "X")).toEqual({ ok: false, slotLabels: ["A", "B"] });
  });
  it("a product that is in no part can always be switched off", () => {
    expect(checkDeactivation(slots, [...products, { sku: "LOOSE", active: true }], "LOOSE")).toEqual({ ok: true });
  });
});

describe("checkStockChange", () => {
  it("allows exactly what is held and more, refuses less", () => {
    expect(checkStockChange(5, 5)).toEqual({ ok: true });
    expect(checkStockChange(9, 5)).toEqual({ ok: true });
    expect(checkStockChange(4, 5)).toEqual({ ok: false, held: 5 });
    expect(checkStockChange(0, 0)).toEqual({ ok: true });
  });
});

describe("checkNewProductSlots", () => {
  it("needs at least one part, and every part must exist", () => {
    expect(checkNewProductSlots(["gift"], slots)).toEqual({ ok: true });
    expect(checkNewProductSlots([], slots)).toMatchObject({ ok: false, reason: "NO_SLOT" });
    expect(checkNewProductSlots(["gift", "nope"], slots)).toEqual({ ok: false, reason: "UNKNOWN_SLOT", unknown: ["nope"] });
  });
});

describe("withSkuInSlots", () => {
  it("adds the SKU to the named parts only, keeps everything else, and does not change its input", () => {
    const before = JSON.stringify(slots);
    const out = withSkuInSlots(slots, "NEW", ["gift"]);
    expect(out.find((s) => s.id === "gift")!.allowedSkus).toEqual(["BOTTLE", "ORGANIZER", "NEW"]);
    expect(out.find((s) => s.id === "notebook")!.allowedSkus).toEqual(["NB"]);
    expect(JSON.stringify(slots)).toBe(before);
  });
  it("does not repeat a SKU", () => {
    expect(withSkuInSlots(slots, "BOTTLE", ["gift"]).find((s) => s.id === "gift")!.allowedSkus).toEqual(["BOTTLE", "ORGANIZER"]);
  });
});

const goodAdd = { sku: "MUG-1", name: "Mug", category: "drinkware", priceMinor: 900, isFood: false, onHand: 10, slotIds: ["gift"] };

describe("addProductSchema", () => {
  it("accepts a good product and trims the name and category", () => {
    expect(addProductSchema.parse({ ...goodAdd, name: "  Mug ", category: " drinkware " })).toMatchObject({ name: "Mug", category: "drinkware" });
  });
  it("refuses every bad value and every unknown key", () => {
    const bad: Record<string, unknown> = {
      "no sku": { ...goodAdd, sku: "" },
      "sku with a space": { ...goodAdd, sku: "MUG 1" },
      "sku starting with a dash": { ...goodAdd, sku: "-MUG" },
      "sku too long": { ...goodAdd, sku: "A".repeat(65) },
      "sku with markup": { ...goodAdd, sku: "<b>" },
      "empty name": { ...goodAdd, name: "   " },
      "long name": { ...goodAdd, name: "x".repeat(LIMITS.nameMax + 1) },
      "empty category": { ...goodAdd, category: "" },
      "long category": { ...goodAdd, category: "x".repeat(LIMITS.categoryMax + 1) },
      "negative price": { ...goodAdd, priceMinor: -1 },
      "fractional price": { ...goodAdd, priceMinor: 9.5 },
      "price as text": { ...goodAdd, priceMinor: "900" },
      "price too high": { ...goodAdd, priceMinor: LIMITS.priceMaxMinor + 1 },
      "food as text": { ...goodAdd, isFood: "no" },
      "negative stock": { ...goodAdd, onHand: -1 },
      "fractional stock": { ...goodAdd, onHand: 1.5 },
      "too much stock": { ...goodAdd, onHand: LIMITS.onHandMax + 1 },
      "no slots": { ...goodAdd, slotIds: [] },
      "repeated slot": { ...goodAdd, slotIds: ["gift", "gift"] },
      "too many slots": { ...goodAdd, slotIds: Array.from({ length: LIMITS.slotsMax + 1 }, (_, i) => `s${i}`) },
      "a merchant id": { ...goodAdd, merchantId: "x" },
      "reserved stock": { ...goodAdd, reserved: 5 },
      "active flag": { ...goodAdd, active: false },
      null: null,
    };
    for (const [why, input] of Object.entries(bad)) expect(addProductSchema.safeParse(input).success, why).toBe(false);
  });
  it("accepts the limits themselves", () => {
    expect(addProductSchema.safeParse({ ...goodAdd, sku: "A".repeat(64), name: "x".repeat(120), category: "y".repeat(64), priceMinor: 0, onHand: 0 }).success).toBe(true);
    expect(addProductSchema.safeParse({ ...goodAdd, priceMinor: LIMITS.priceMaxMinor, onHand: LIMITS.onHandMax }).success).toBe(true);
  });
});

describe("editProductSchema", () => {
  it("accepts any one editable field", () => {
    for (const patch of [{ name: "A" }, { category: "b" }, { priceMinor: 0 }, { isFood: true }, { active: false }, { onHand: 0 }]) {
      expect(editProductSchema.safeParse(patch).success, JSON.stringify(patch)).toBe(true);
    }
  });
  it("refuses an empty patch, a SKU change, any unknown key and any bad value", () => {
    const bad: unknown[] = [{}, { sku: "NEW" }, { name: "A", sku: "NEW" }, { merchantId: "x" }, { reserved: 1 }, { id: "x" }, { name: "" }, { priceMinor: 1.5 }, { priceMinor: -5 }, { priceMinor: "5" }, { onHand: -1 }, { onHand: 2.5 }, { active: "yes" }, { name: undefined }, null, "x"];
    for (const patch of bad) expect(editProductSchema.safeParse(patch).success, JSON.stringify(patch)).toBe(false);
  });
});
