import { describe, expect, it } from "vitest";
import { calculateQuote } from "@/domain/catalog/price";
import type { Catalog, Configuration, Product, Slot } from "@/domain/catalog/types";
import { cents } from "@/lib/money";

const product = (sku: string, name: string, price: number): Product => ({
  id: `id-${sku}`,
  sku,
  name,
  category: "misc",
  unitPriceMinor: cents(price),
  isFood: false,
  active: true,
});

const slot = (id: string, allowedSkus: string[], quantity = 1): Slot => ({ id, label: id, quantity, allowedSkus });

const catalog: Catalog = {
  products: [
    product("NB", "Notebook", 1200),
    product("PEN", "Pen", 300),
    product("BOT", "Bottle", 1300),
    product("ORG", "Desk organizer", 1400),
    product("CARD", "Branded card", 200),
    product("PKG", "Packaging", 500),
  ],
  slots: [
    slot("notebook", ["NB"]),
    slot("pen", ["PEN"]),
    slot("gift", ["BOT", "ORG"]),
    slot("card", ["CARD"]),
    slot("packaging", ["PKG"]),
  ],
  rules: { productionLeadDays: 0 },
};

const config = (gift: string, boxCount: number): Configuration => ({
  boxCount,
  selections: { notebook: "NB", pen: "PEN", gift, card: "CARD", packaging: "PKG" },
});

describe("calculateQuote", () => {
  it("prices the demo box with the bottle: 3500 per box, 70000 for 20", () => {
    const q = calculateQuote(config("BOT", 20), catalog);
    expect(q.perBoxMinor).toBe(3500);
    expect(q.totalMinor).toBe(70000);
    expect(q.boxCount).toBe(20);
    expect(q.currency).toBe("USD");
  });

  it("prices the demo box with the organizer: 3600 per box, 108000 for 30", () => {
    const q = calculateQuote(config("ORG", 30), catalog);
    expect(q.perBoxMinor).toBe(3600);
    expect(q.totalMinor).toBe(108000);
  });

  it("carries its lines in slot order with slot, sku, name, unit price and quantity", () => {
    const q = calculateQuote(config("BOT", 20), catalog);
    expect(q.lines).toEqual([
      { slotId: "notebook", sku: "NB", name: "Notebook", unitPriceMinor: 1200, quantity: 1 },
      { slotId: "pen", sku: "PEN", name: "Pen", unitPriceMinor: 300, quantity: 1 },
      { slotId: "gift", sku: "BOT", name: "Bottle", unitPriceMinor: 1300, quantity: 1 },
      { slotId: "card", sku: "CARD", name: "Branded card", unitPriceMinor: 200, quantity: 1 },
      { slotId: "packaging", sku: "PKG", name: "Packaging", unitPriceMinor: 500, quantity: 1 },
    ]);
  });

  it("multiplies unit price by slot quantity", () => {
    const c: Catalog = { ...catalog, slots: [slot("pen", ["PEN"], 3)] };
    const q = calculateQuote({ boxCount: 2, selections: { pen: "PEN" } }, c);
    expect(q.perBoxMinor).toBe(900);
    expect(q.totalMinor).toBe(1800);
    expect(q.lines[0]?.quantity).toBe(3);
  });

  it("does not mutate its inputs", () => {
    const cfg = config("BOT", 20);
    const before = JSON.stringify([cfg, catalog]);
    calculateQuote(cfg, catalog);
    expect(JSON.stringify([cfg, catalog])).toBe(before);
  });

  it("throws on overflow instead of losing precision", () => {
    const c: Catalog = { ...catalog, products: [product("BIG", "Big", Number.MAX_SAFE_INTEGER)], slots: [slot("a", ["BIG"])] };
    expect(() => calculateQuote({ boxCount: 2, selections: { a: "BIG" } }, c)).toThrow(RangeError);
  });

  it("throws on a selection that is not in the catalog (a programmer bug; validate first)", () => {
    expect(() => calculateQuote({ boxCount: 1, selections: { notebook: "NOPE" } }, catalog)).toThrow();
  });

  it("is deterministic", () => {
    expect(calculateQuote(config("ORG", 7), catalog)).toEqual(calculateQuote(config("ORG", 7), catalog));
  });
});
