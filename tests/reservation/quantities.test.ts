import { describe, expect, it } from "vitest";
import { requiredQuantities } from "@/domain/reservation/quantities";
import { cents } from "@/lib/money";

const line = (slotId: string, sku: string, quantity = 1) => ({ slotId, sku, name: sku, unitPriceMinor: cents(100), quantity });

const ids = new Map([
  ["NB", "p-1"],
  ["PEN", "p-2"],
  ["ORG", "p-3"],
  ["CARD", "p-4"],
  ["PKG", "p-5"],
]);

describe("requiredQuantities", () => {
  it("the demo box: 30 boxes need 30 of each of five products", () => {
    const need = requiredQuantities(
      { boxCount: 30, lines: [line("notebook", "NB"), line("pen", "PEN"), line("gift", "ORG"), line("card", "CARD"), line("packaging", "PKG")] },
      ids,
    );
    expect(need).toEqual([
      { productId: "p-1", quantity: 30 },
      { productId: "p-2", quantity: 30 },
      { productId: "p-3", quantity: 30 },
      { productId: "p-4", quantity: 30 },
      { productId: "p-5", quantity: 30 },
    ]);
  });

  it("a product in two slots counts twice, in one line", () => {
    const need = requiredQuantities({ boxCount: 10, lines: [line("a", "NB", 1), line("b", "NB", 2)] }, ids);
    expect(need).toEqual([{ productId: "p-1", quantity: 30 }]);
  });

  it("multiplies the slot quantity by the box count", () => {
    expect(requiredQuantities({ boxCount: 4, lines: [line("a", "PEN", 3)] }, ids)).toEqual([{ productId: "p-2", quantity: 12 }]);
  });

  it("is sorted by product id, which is the order stock rows are locked in", () => {
    const shuffled = requiredQuantities({ boxCount: 1, lines: [line("x", "PKG"), line("y", "NB"), line("z", "ORG")] }, ids);
    expect(shuffled.map((n) => n.productId)).toEqual(["p-1", "p-3", "p-5"]);
  });

  it("accepts a plain object as the SKU map", () => {
    expect(requiredQuantities({ boxCount: 2, lines: [line("a", "NB")] }, { NB: "p-9" })).toEqual([{ productId: "p-9", quantity: 2 }]);
  });

  it("does not mutate its input", () => {
    const input = { boxCount: 3, lines: [line("a", "NB")] };
    const copy = structuredClone(input);
    requiredQuantities(input, ids);
    expect(input).toEqual(copy);
  });

  it("throws on a SKU the merchant does not sell (a programmer bug, never a customer outcome)", () => {
    expect(() => requiredQuantities({ boxCount: 1, lines: [line("a", "GHOST")] }, ids)).toThrow(/GHOST/);
  });

  it.each([
    ["zero boxes", { boxCount: 0, lines: [line("a", "NB")] }],
    ["a fractional box count", { boxCount: 2.5, lines: [line("a", "NB")] }],
    ["a negative box count", { boxCount: -1, lines: [line("a", "NB")] }],
    ["no lines", { boxCount: 1, lines: [] }],
    ["a zero line quantity", { boxCount: 1, lines: [line("a", "NB", 0)] }],
    ["a fractional line quantity", { boxCount: 1, lines: [line("a", "NB", 1.5)] }],
  ])("throws on %s", (_name, snapshot) => {
    expect(() => requiredQuantities(snapshot, ids)).toThrow();
  });

  it("throws rather than lose precision on an overflowing quantity", () => {
    expect(() => requiredQuantities({ boxCount: Number.MAX_SAFE_INTEGER, lines: [line("a", "NB", 2)] }, ids)).toThrow();
  });
});
