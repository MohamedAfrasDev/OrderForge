import { describe, expect, it } from "vitest";
import { validateConfiguration } from "@/domain/catalog/validate";
import type { Blocker, Catalog, Product, Requirements, Slot, ValidationInput } from "@/domain/catalog/types";
import { cents } from "@/lib/money";

const product = (sku: string, price: number, over: Partial<Product> = {}): Product => ({
  id: `id-${sku}`,
  sku,
  name: sku,
  category: "misc",
  unitPriceMinor: cents(price),
  isFood: false,
  active: true,
  ...over,
});

const giftSlot: Slot = { id: "gift", label: "Gift", quantity: 1, allowedSkus: ["BOT", "TRF"] };
const cardSlot: Slot = { id: "card", label: "Card", quantity: 1, allowedSkus: ["CARD"], customization: "logo" };

const makeCatalog = (
  rules: Catalog["rules"] = { productionLeadDays: 0 },
  slots: Slot[] = [giftSlot, cardSlot],
): Catalog => ({
  products: [product("BOT", 1300), product("TRF", 900, { isFood: true }), product("CARD", 200)],
  slots,
  rules,
});

const input = (
  over: {
    requirements?: Partial<Requirements>;
    catalog?: Catalog;
    selections?: Record<string, string>;
    boxCount?: number;
    today?: string;
  } = {},
): ValidationInput => ({
  configuration: { boxCount: over.boxCount ?? 10, selections: over.selections ?? { gift: "BOT", card: "CARD" } },
  catalog: over.catalog ?? makeCatalog(),
  requirements: { noFood: false, logoRequired: false, ...over.requirements },
  stock: { "id-BOT": 1000, "id-TRF": 1000, "id-CARD": 1000 },
  today: over.today ?? "2026-11-02",
});

function blockersOf(i: ValidationInput): Blocker[] {
  const r = validateConfiguration(i);
  if (r.ok) throw new Error("expected blocked");
  return r.blockers;
}

describe("FOOD_NOT_ALLOWED", () => {
  it("blocks a food product under noFood", () => {
    expect(blockersOf(input({ requirements: { noFood: true }, selections: { gift: "TRF", card: "CARD" } }))).toEqual([
      { code: "FOOD_NOT_ALLOWED", slotId: "gift", sku: "TRF" },
    ]);
  });
  it("allows food when noFood is false, and non-food when noFood is true", () => {
    expect(validateConfiguration(input({ selections: { gift: "TRF", card: "CARD" } })).ok).toBe(true);
    expect(validateConfiguration(input({ requirements: { noFood: true } })).ok).toBe(true);
  });
});

describe("LOGO_NOT_COVERED", () => {
  it("is blocked when the template has no logo slot", () => {
    const catalog = makeCatalog({ productionLeadDays: 0 }, [giftSlot, { ...cardSlot, customization: undefined }]);
    expect(blockersOf(input({ catalog, requirements: { logoRequired: true } }))).toEqual([{ code: "LOGO_NOT_COVERED" }]);
  });
  it("is blocked when the logo slot is not filled (reported with SLOT_NOT_FILLED)", () => {
    expect(blockersOf(input({ requirements: { logoRequired: true }, selections: { gift: "BOT" } }))).toEqual([
      { code: "SLOT_NOT_FILLED", slotId: "card" },
      { code: "LOGO_NOT_COVERED" },
    ]);
  });
  it("is satisfied by a selection in a logo slot, and ignored when logo is not required", () => {
    expect(validateConfiguration(input({ requirements: { logoRequired: true } })).ok).toBe(true);
    const noLogoSlot = makeCatalog({ productionLeadDays: 0 }, [giftSlot]);
    expect(validateConfiguration(input({ catalog: noLogoSlot, selections: { gift: "BOT" } })).ok).toBe(true);
  });
});

describe("BELOW_MIN_QUANTITY", () => {
  const rules = { productionLeadDays: 0, minOrderQuantity: 12 };
  it("blocks below the merchant minimum", () => {
    expect(blockersOf(input({ catalog: makeCatalog(rules), boxCount: 11 }))).toEqual([
      { code: "BELOW_MIN_QUANTITY", boxCount: 11, minimum: 12 },
    ]);
  });
  it("allows exactly the minimum, and any count when no rule exists", () => {
    expect(validateConfiguration(input({ catalog: makeCatalog(rules), boxCount: 12 })).ok).toBe(true);
    expect(validateConfiguration(input({ boxCount: 1 })).ok).toBe(true);
  });
  it("does not double-report an invalid box count", () => {
    expect(blockersOf(input({ catalog: makeCatalog(rules), boxCount: 0 }))).toEqual([
      { code: "INVALID_QUANTITY", boxCount: 0 },
    ]);
  });
});

describe("UNSUPPORTED_DATE", () => {
  const lead = (days: number) => makeCatalog({ productionLeadDays: days });
  it("the earliest day (today + lead days) is valid; the day before is blocked", () => {
    expect(validateConfiguration(input({ catalog: lead(5), requirements: { requestedPickupDate: "2026-11-07" } })).ok).toBe(true);
    expect(blockersOf(input({ catalog: lead(5), requirements: { requestedPickupDate: "2026-11-06" } }))).toEqual([
      { code: "UNSUPPORTED_DATE", requested: "2026-11-06", earliest: "2026-11-07" },
    ]);
  });
  it("later days are valid; no requested date means no check", () => {
    expect(validateConfiguration(input({ catalog: lead(5), requirements: { requestedPickupDate: "2027-01-01" } })).ok).toBe(true);
    expect(validateConfiguration(input({ catalog: lead(5) })).ok).toBe(true);
  });
  it("handles month end, year end and leap day", () => {
    const at = (today: string, days: number, requested: string) =>
      validateConfiguration(input({ today, catalog: lead(days), requirements: { requestedPickupDate: requested } })).ok;
    expect(at("2026-01-30", 2, "2026-02-01")).toBe(true);
    expect(at("2026-01-30", 2, "2026-01-31")).toBe(false);
    expect(at("2026-12-30", 2, "2027-01-01")).toBe(true);
    expect(at("2026-12-30", 2, "2026-12-31")).toBe(false);
    expect(at("2028-02-27", 2, "2028-02-29")).toBe(true);
    expect(at("2028-02-27", 2, "2028-02-28")).toBe(false);
  });
  it("blocks a requested value that is not a real calendar date", () => {
    expect(blockersOf(input({ requirements: { requestedPickupDate: "2026-02-30" } }))).toEqual([
      { code: "UNSUPPORTED_DATE", requested: "2026-02-30", earliest: "2026-11-02" },
    ]);
  });
  it("uses the passed-in today, never the clock", () => {
    expect(validateConfiguration(input({ today: "2020-01-01", requirements: { requestedPickupDate: "2020-01-01" } })).ok).toBe(true);
  });
});

describe("combined constraint blockers", () => {
  it("are reported together after structure and product blockers, date last", () => {
    const catalog = makeCatalog({ productionLeadDays: 3, minOrderQuantity: 50 });
    const i = input({
      catalog,
      boxCount: 10,
      selections: { gift: "TRF", card: "GHOST" },
      requirements: { noFood: true, logoRequired: true, requestedPickupDate: "2026-11-03" },
    });
    expect(blockersOf(i).map((b) => b.code)).toEqual([
      "UNKNOWN_PRODUCT",
      "FOOD_NOT_ALLOWED",
      "BELOW_MIN_QUANTITY",
      "UNSUPPORTED_DATE",
    ]);
  });
});
