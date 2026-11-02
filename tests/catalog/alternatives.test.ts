import { describe, expect, it } from "vitest";
import { proposeAlternatives } from "@/domain/catalog/alternatives";
import { validateConfiguration } from "@/domain/catalog/validate";
import type { Catalog, Product, Slot, Stock, ValidationInput } from "@/domain/catalog/types";
import { cents } from "@/lib/money";
import { demoInput, product, withGift } from "./fixtures";
import { chance, createRng, int, shuffled, type Rng } from "./random";

describe("proposeAlternatives: demo path C", () => {
  const blocked = demoInput({ configuration: { boxCount: 30, selections: withGift("BOT-01") } });

  it("offers exactly the desk organizer instead of the bottle, and never the truffles", () => {
    const r = proposeAlternatives(blocked);
    expect(r.alternatives).toHaveLength(1);
    const alt = r.alternatives[0]!;
    expect(alt).toMatchObject({ slotId: "gift", fromSku: "BOT-01", toSku: "ORG-01", perBoxDeltaMinor: 100 });
    expect(alt.priced.perBoxMinor).toBe(3600);
    expect(alt.priced.totalMinor).toBe(108000);
    expect(r.alternatives.some((a) => a.toSku === "TRF-01")).toBe(false);
  });

  it("counts every swap it tried (bottle's slot: organizer and truffles)", () => {
    expect(proposeAlternatives(blocked).considered).toBe(2);
  });

  it("offers the truffles when food is allowed", () => {
    const i = demoInput({
      configuration: { boxCount: 30, selections: withGift("BOT-01") },
      requirements: { noFood: false, logoRequired: true, maxPricePerBoxMinor: cents(3999) },
    });
    expect(proposeAlternatives(i).alternatives.map((a) => a.toSku)).toEqual(["ORG-01", "TRF-01"]);
  });
});

describe("proposeAlternatives: rules", () => {
  const slots: Slot[] = [
    { id: "a", label: "A", quantity: 1, allowedSkus: ["A1", "A2", "A3", "A4"] },
    { id: "b", label: "B", quantity: 1, allowedSkus: ["B1", "B2"] },
  ];
  const products: Product[] = [
    product("A1", "A1", 1000),
    product("A2", "A2", 1100),
    product("A3", "A3", 900),
    product("A4", "A4", 1100, { active: false }),
    product("B1", "B1", 500),
    product("B2", "B2", 600),
  ];
  const catalog: Catalog = { products, slots, rules: { productionLeadDays: 0 } };
  const stock: Stock = Object.fromEntries(products.map((p) => [p.id, 1000]));
  const base: ValidationInput = {
    configuration: { boxCount: 5, selections: { a: "A1", b: "B1" } },
    catalog,
    requirements: { noFood: false, logoRequired: false },
    stock,
    today: "2026-11-02",
  };

  it("orders by smallest absolute price change, then slot order, then allowed-list order, then SKU", () => {
    const r = proposeAlternatives(base);
    // deltas: a:A2 +100, a:A3 -100, b:B2 +100; A4 inactive is not offered
    expect(r.alternatives.map((a) => `${a.slotId}:${a.toSku}`)).toEqual(["a:A2", "a:A3", "b:B2"]);
  });

  it("puts the smaller change first even from a later slot", () => {
    const cheaper = { ...catalog, products: products.map((p) => (p.sku === "B2" ? { ...p, unitPriceMinor: cents(550) } : p)) };
    expect(proposeAlternatives({ ...base, catalog: cheaper }).alternatives.map((a) => a.toSku)).toEqual(["B2", "A2", "A3"]);
  });

  it("breaks full ties by SKU", () => {
    const tied: Catalog = {
      ...catalog,
      products: [...products, product("A0", "A0", 1100)],
      slots: [{ ...slots[0]!, allowedSkus: ["A1", "A2", "A0"] }, slots[1]!],
    };
    // A2 and A0 both +100, same slot; A2 comes first in the allowed list, so list order wins before SKU
    expect(proposeAlternatives({ ...base, catalog: tied, stock: { ...stock, "id-A0": 1000 } }).alternatives.map((a) => a.toSku)).toEqual(["A2", "A0", "B2"]);
  });

  it("respects the limit, defaulting to 5 and capping at 20", () => {
    expect(proposeAlternatives(base, { limit: 2 }).alternatives).toHaveLength(2);
    const many: Product[] = Array.from({ length: 40 }, (_, k) => product(`M${k}`, `M${k}`, 1000 + k));
    const big: ValidationInput = {
      ...base,
      catalog: { products: many, slots: [{ id: "a", label: "A", quantity: 1, allowedSkus: many.map((p) => p.sku) }], rules: { productionLeadDays: 0 } },
      configuration: { boxCount: 1, selections: { a: "M0" } },
      stock: Object.fromEntries(many.map((p) => [p.id, 10])),
    };
    expect(proposeAlternatives(big).alternatives).toHaveLength(5);
    expect(proposeAlternatives(big, { limit: 100 }).alternatives).toHaveLength(20);
    expect(proposeAlternatives(big, { limit: 100 }).considered).toBe(39);
  });

  it("never offers an SKU the catalog does not have, even if a slot's list names it", () => {
    const ghostly: Catalog = {
      ...catalog,
      slots: [{ ...slots[0]!, allowedSkus: ["A1", "GHOST", "A2"] }, slots[1]!],
    };
    const r = proposeAlternatives({ ...base, catalog: ghostly });
    expect(r.alternatives.map((a) => a.toSku)).toEqual(["A2", "B2"]);
    expect(r.considered).toBe(3); // GHOST was tried and rejected by validation
  });

  it("rejects a limit below 1 or not an integer", () => {
    expect(() => proposeAlternatives(base, { limit: 0 })).toThrow(RangeError);
    expect(() => proposeAlternatives(base, { limit: 1.5 })).toThrow(RangeError);
  });

  it("offers nothing for a box whose problem no single swap can fix", () => {
    const r = proposeAlternatives({ ...base, configuration: { boxCount: 0, selections: base.configuration.selections } });
    expect(r.alternatives).toEqual([]);
  });

  it("never offers an inactive product, and does not mutate its input", () => {
    const before = JSON.stringify(base);
    const r = proposeAlternatives(base);
    expect(JSON.stringify(base)).toBe(before);
    expect(r.alternatives.some((a) => a.toSku === "A4")).toBe(false);
  });
});

// ---- properties over seeded pseudo-random catalogs ----

function randomInput(rng: Rng): ValidationInput {
  const pool: Product[] = Array.from({ length: int(rng, 3, 10) }, (_, k) =>
    product(`P${k}`, `P${k}`, int(rng, 1, 5000), { isFood: chance(rng, 0.3), active: chance(rng, 0.85) }),
  );
  const slots: Slot[] = Array.from({ length: int(rng, 1, 5) }, (_, s) => ({
    id: `s${s}`,
    label: `S${s}`,
    quantity: int(rng, 1, 3),
    allowedSkus: shuffled(rng, pool).slice(0, int(rng, 1, pool.length)).map((p) => p.sku),
    ...(chance(rng, 0.3) ? { customization: "logo" as const } : {}),
  }));
  const selections = Object.fromEntries(slots.map((s) => [s.id, s.allowedSkus[int(rng, 0, s.allowedSkus.length - 1)]!]));
  const stock: Stock = Object.fromEntries(pool.map((p) => [p.id, int(rng, 0, 60)]));
  return {
    configuration: { boxCount: int(rng, 1, 25), selections },
    catalog: { products: pool, slots, rules: { productionLeadDays: int(rng, 0, 5) } },
    requirements: {
      noFood: chance(rng, 0.5),
      logoRequired: chance(rng, 0.3),
      ...(chance(rng, 0.7) ? { maxPricePerBoxMinor: cents(int(rng, 1000, 20000)) } : {}),
    },
    stock,
    today: "2026-11-02",
  };
}

describe("proposeAlternatives: properties (seeded)", () => {
  const SEEDS = Array.from({ length: 300 }, (_, k) => k + 1);

  it("every alternative is valid, differs in exactly one slot, respects noFood, and arithmetic holds", () => {
    let offered = 0;
    for (const seed of SEEDS) {
      const input = randomInput(createRng(seed));
      const { alternatives } = proposeAlternatives(input);
      offered += alternatives.length;
      for (const alt of alternatives) {
        const swapped = { ...input.configuration.selections, [alt.slotId]: alt.toSku };
        const r = validateConfiguration({ ...input, configuration: { ...input.configuration, selections: swapped } });
        expect(r.ok, `seed ${seed}`).toBe(true);
        const diff = Object.keys(swapped).filter((k) => swapped[k] !== input.configuration.selections[k]);
        expect(diff, `seed ${seed}`).toEqual([alt.slotId]);
        if (input.requirements.noFood) {
          expect(input.catalog.products.find((p) => p.sku === alt.toSku)!.isFood, `seed ${seed}`).toBe(false);
        }
        expect(alt.priced.totalMinor, `seed ${seed}`).toBe(alt.priced.perBoxMinor * alt.priced.boxCount);
        expect(alt.priced.perBoxMinor, `seed ${seed}`).toBe(
          alt.priced.lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0),
        );
      }
    }
    expect(offered).toBeGreaterThan(100); // the property is not vacuous
  });

  it("is bounded, sorted by absolute price change, and the same on repeat", () => {
    for (const seed of SEEDS) {
      const input = randomInput(createRng(seed));
      const slotsTimesAllowed = input.catalog.slots.reduce((n, s) => n + s.allowedSkus.length, 0);
      const first = proposeAlternatives(input, { limit: 20 });
      expect(first.alternatives.length, `seed ${seed}`).toBeLessThanOrEqual(20);
      expect(first.considered, `seed ${seed}`).toBeLessThanOrEqual(slotsTimesAllowed);
      const deltas = first.alternatives.map((a) => Math.abs(a.perBoxDeltaMinor));
      expect(deltas, `seed ${seed}`).toEqual([...deltas].sort((x, y) => x - y));
      expect(proposeAlternatives(input, { limit: 20 }), `seed ${seed}`).toEqual(first);
    }
  });

  it("does not depend on the order of the products array or of the selection keys", () => {
    for (const seed of SEEDS) {
      const input = randomInput(createRng(seed));
      const rng = createRng(seed + 10_000);
      const entries = shuffled(rng, Object.entries(input.configuration.selections));
      const shuffledInput: ValidationInput = {
        ...input,
        catalog: { ...input.catalog, products: shuffled(rng, input.catalog.products) },
        configuration: { ...input.configuration, selections: Object.fromEntries(entries) },
        stock: Object.fromEntries(shuffled(rng, Object.entries(input.stock))),
      };
      expect(proposeAlternatives(shuffledInput, { limit: 20 }), `seed ${seed}`).toEqual(
        proposeAlternatives(input, { limit: 20 }),
      );
    }
  });
});

