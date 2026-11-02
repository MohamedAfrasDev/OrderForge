import { describe, expect, it } from "vitest";
import { validateConfiguration } from "@/domain/catalog/validate";
import type { Blocker, Catalog, Product, Slot, ValidationInput } from "@/domain/catalog/types";
import { cents } from "@/lib/money";

const product = (sku: string, name: string, price: number, over: Partial<Product> = {}): Product => ({
  id: `id-${sku}`,
  sku,
  name,
  category: "misc",
  unitPriceMinor: cents(price),
  isFood: false,
  active: true,
  ...over,
});

const slot = (id: string, allowedSkus: string[]): Slot => ({ id, label: id, quantity: 1, allowedSkus });

const catalog: Catalog = {
  products: [
    product("NB", "Notebook", 1200),
    product("PEN", "Pen", 300),
    product("BOT", "Bottle", 1300),
    product("ORG", "Desk organizer", 1400),
    product("OLD", "Retired mug", 900, { active: false }),
  ],
  slots: [slot("notebook", ["NB"]), slot("pen", ["PEN"]), slot("gift", ["BOT", "ORG", "OLD"])],
  rules: { productionLeadDays: 0 },
};

const input = (selections: Record<string, string>, boxCount = 10): ValidationInput => ({
  configuration: { boxCount, selections },
  catalog,
  requirements: { noFood: false, logoRequired: false },
  stock: { "id-NB": 1000, "id-PEN": 1000, "id-BOT": 1000, "id-ORG": 1000, "id-OLD": 1000 },
  today: "2026-11-02",
});

const full = { notebook: "NB", pen: "PEN", gift: "BOT" };

function blockersOf(i: ValidationInput): Blocker[] {
  const r = validateConfiguration(i);
  if (r.ok) throw new Error("expected blocked");
  return r.blockers;
}

describe("validateConfiguration: structure and product blockers", () => {
  it("returns ok with a priced configuration for a valid structure", () => {
    const r = validateConfiguration(input(full, 20));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.priced.perBoxMinor).toBe(2800);
      expect(r.priced.totalMinor).toBe(56000);
    }
  });

  it.each([0, -3, 2.5, NaN, Infinity])("INVALID_QUANTITY for boxCount %s", (boxCount) => {
    const b = blockersOf(input(full, boxCount));
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ code: "INVALID_QUANTITY" });
  });

  it("UNKNOWN_SLOT for a selection whose slot is not in the template", () => {
    expect(blockersOf(input({ ...full, engraving: "NB" }))).toEqual([{ code: "UNKNOWN_SLOT", slotId: "engraving" }]);
  });

  it("SLOT_NOT_FILLED for a template slot with no selection", () => {
    expect(blockersOf(input({ notebook: "NB", pen: "PEN" }))).toEqual([{ code: "SLOT_NOT_FILLED", slotId: "gift" }]);
  });

  it("UNKNOWN_PRODUCT for an SKU the catalog does not have, before any price exists", () => {
    const r = validateConfiguration(input({ ...full, gift: "GHOST-999" }));
    expect(r).toEqual({ ok: false, blockers: [{ code: "UNKNOWN_PRODUCT", slotId: "gift", sku: "GHOST-999" }] });
  });

  it("INACTIVE_PRODUCT for a product that is switched off", () => {
    expect(blockersOf(input({ ...full, gift: "OLD" }))).toEqual([{ code: "INACTIVE_PRODUCT", slotId: "gift", sku: "OLD" }]);
  });

  it("PRODUCT_NOT_ALLOWED_IN_SLOT for a real product outside the slot's list", () => {
    expect(blockersOf(input({ ...full, pen: "BOT" }))).toEqual([
      { code: "PRODUCT_NOT_ALLOWED_IN_SLOT", slotId: "pen", sku: "BOT" },
    ]);
  });

  it("an unknown product is reported once, not also as not-allowed", () => {
    expect(blockersOf(input({ ...full, pen: "GHOST" }))).toEqual([{ code: "UNKNOWN_PRODUCT", slotId: "pen", sku: "GHOST" }]);
  });

  it("an inactive product outside the slot's list gets both blockers", () => {
    expect(blockersOf(input({ ...full, pen: "OLD" }))).toEqual([
      { code: "INACTIVE_PRODUCT", slotId: "pen", sku: "OLD" },
      { code: "PRODUCT_NOT_ALLOWED_IN_SLOT", slotId: "pen", sku: "OLD" },
    ]);
  });

  it("reports everything together: structure first (quantity, unknown slot, unfilled), then product, in slot order", () => {
    const b = blockersOf(input({ notebook: "GHOST", pen: "BOT", zzz: "NB", aaa: "NB" }, 0));
    expect(b).toEqual([
      { code: "INVALID_QUANTITY", boxCount: 0 },
      { code: "UNKNOWN_SLOT", slotId: "aaa" },
      { code: "UNKNOWN_SLOT", slotId: "zzz" },
      { code: "SLOT_NOT_FILLED", slotId: "gift" },
      { code: "UNKNOWN_PRODUCT", slotId: "notebook", sku: "GHOST" },
      { code: "PRODUCT_NOT_ALLOWED_IN_SLOT", slotId: "pen", sku: "BOT" },
    ]);
  });

  it("does not depend on the order of selection keys", () => {
    const a = blockersOf(input({ zzz: "NB", aaa: "NB", notebook: "NB", pen: "PEN", gift: "BOT" }));
    const b = blockersOf(input({ gift: "BOT", pen: "PEN", notebook: "NB", aaa: "NB", zzz: "NB" }));
    expect(a).toEqual(b);
  });

  it("never returns a price for a blocked box", () => {
    const r = validateConfiguration(input({ ...full, gift: "GHOST" }));
    expect(r).not.toHaveProperty("priced");
  });

  it("does not mutate its input", () => {
    const i = input({ ...full, gift: "GHOST", extra: "NB" }, 0);
    const before = JSON.stringify(i);
    validateConfiguration(i);
    expect(JSON.stringify(i)).toBe(before);
  });
});
