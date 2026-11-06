// The seed fixtures for the two demo shops. Pure: no database. Figures are asserted through the real catalog engine, never copied by hand.
import { describe, expect, it } from "vitest";
import { proposeAlternatives, validateConfiguration } from "@/domain/catalog";
import type { Catalog, Product, Stock, ValidationInput } from "@/domain/catalog/types";
import { boxTemplateRuleSchema } from "@/domain/catalog";
import { cents } from "@/lib/money";
import { MERCHANT_ID, merchant, products, shops, type Shop } from "@/supabase/seed/fixtures";

function catalogOf(shop: Shop): { catalog: Catalog; stock: Stock } {
  const template = boxTemplateRuleSchema.parse(shop.rules.find((r) => r.key === "box_template")!.value);
  const catalogProducts: Product[] = shop.products.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    category: p.category,
    unitPriceMinor: cents(p.unit_price_minor),
    isFood: p.is_food,
    active: true,
  }));
  const stock: Stock = {};
  for (const s of shop.stock) stock[s.product_id] = s.on_hand - s.reserved;
  return { catalog: { products: catalogProducts, slots: template.slots, rules: { productionLeadDays: 7 } }, stock };
}

function input(shop: Shop, boxCount: number, selections: Record<string, string>): ValidationInput {
  const { catalog, stock } = catalogOf(shop);
  return {
    configuration: { boxCount, selections },
    catalog,
    requirements: { noFood: true, logoRequired: true, maxPricePerBoxMinor: cents(4000) },
    stock,
    today: "2026-11-06",
  };
}

const [giftBoxes, eventKits] = shops;

describe("the shops list", () => {
  it("has the existing gift-box shop first and unchanged, and a second shop", () => {
    expect(shops).toHaveLength(2);
    expect(giftBoxes.merchant).toEqual(merchant);
    expect(giftBoxes.merchant.id).toBe(MERCHANT_ID);
    expect(giftBoxes.merchant.slug).toBe("demo-gift-boxes");
    expect(giftBoxes.products).toEqual(products);
  });

  it("gives the second shop its own fixed id and slug", () => {
    expect(eventKits.merchant.slug).toBe("demo-event-kits");
    expect(eventKits.merchant.name).toContain("(simulated)");
    expect(eventKits.merchant.id).not.toBe(giftBoxes.merchant.id);
    expect(eventKits.merchant.currency).toBe("USD");
  });

  it("shares no id between shops, and every row belongs to its own shop", () => {
    const ids = shops.flatMap((s) => [s.merchant.id, ...s.products.map((p) => p.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of shops) {
      expect(s.products.every((p) => p.merchant_id === s.merchant.id)).toBe(true);
      expect(s.rules.every((r) => r.merchant_id === s.merchant.id)).toBe(true);
      const own = new Set(s.products.map((p) => p.id));
      expect(s.stock.every((st) => own.has(st.product_id))).toBe(true);
      expect(s.stock).toHaveLength(s.products.length);
    }
  });

  it("keeps SKUs unique within a shop, and the second shop's SKUs differ from the first's", () => {
    for (const s of shops) expect(new Set(s.products.map((p) => p.sku)).size).toBe(s.products.length);
    const first = new Set(giftBoxes.products.map((p) => p.sku));
    expect(eventKits.products.some((p) => first.has(p.sku))).toBe(false);
  });

  it("names a different owner login (two environment variables each) for each shop", () => {
    expect(giftBoxes.owner).toEqual({ emailVar: "DEMO_MERCHANT_EMAIL", passwordVar: "DEMO_MERCHANT_PASSWORD" });
    expect(eventKits.owner).toEqual({ emailVar: "DEMO_MERCHANT2_EMAIL", passwordVar: "DEMO_MERCHANT2_PASSWORD" });
  });

  it("gives every shop the five rules the app reads, including who it is for (shop_profile)", () => {
    for (const s of shops) {
      expect(s.rules.map((r) => r.key).sort()).toEqual(["box_template", "fulfilment", "logo_print", "production_lead_days", "shop_profile"]);
    }
    const kind = (s: Shop) => (s.rules.find((r) => r.key === "shop_profile")!.value as { productKind: string }).productKind;
    expect(kind(giftBoxes)).toBe("gift box");
    expect(kind(eventKits)).toBe("event welcome kit");
  });

  it("only has box templates the engine accepts, whose SKUs all exist in that shop and nowhere else", () => {
    for (const s of shops) {
      const template = boxTemplateRuleSchema.parse(s.rules.find((r) => r.key === "box_template")!.value);
      const own = new Set(s.products.map((p) => p.sku));
      for (const slot of template.slots) for (const sku of slot.allowedSkus) expect(own.has(sku), `${s.merchant.slug}: ${sku}`).toBe(true);
    }
  });
});

describe("the first shop's figures are unchanged", () => {
  const sel = (gift: string) => ({ notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift, card: "CARD-BRANDED", packaging: "PACK-BOX" });

  it("20 boxes with the bottle: $35 a box, $700", () => {
    const r = validateConfiguration(input(giftBoxes, 20, sel("BOTTLE-STEEL")));
    expect(r.ok && [r.priced.perBoxMinor, r.priced.totalMinor]).toEqual([3500, 70000]);
  });

  it("30 boxes with the bottle is blocked by stock (need 30, have 24)", () => {
    expect(validateConfiguration(input(giftBoxes, 30, sel("BOTTLE-STEEL")))).toEqual({
      ok: false,
      blockers: [{ code: "INSUFFICIENT_STOCK", sku: "BOTTLE-STEEL", needed: 30, available: 24 }],
    });
  });
});

describe("the second shop (event welcome kits)", () => {
  const sel = (drink: string) => ({ tote: "TOTE-CANVAS", lanyard: "LANYARD-PRINT", drink, stickers: "STICKERS-PACK", packaging: "PACK-KIT" });

  it("has no food products, so a no-food request is never in conflict", () => {
    expect(eventKits.products.some((p) => p.is_food)).toBe(false);
  });

  it("20 kits with the insulated bottle: $33.50 a kit, $670", () => {
    const r = validateConfiguration(input(eventKits, 20, sel("BOTTLE-INSULATED")));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.priced.perBoxMinor).toBe(3350);
      expect(r.priced.totalMinor).toBe(67000);
    }
  });

  it("50 kits with the insulated bottle is blocked by stock (need 50, have 40)", () => {
    expect(validateConfiguration(input(eventKits, 50, sel("BOTTLE-INSULATED")))).toEqual({
      ok: false,
      blockers: [{ code: "INSUFFICIENT_STOCK", sku: "BOTTLE-INSULATED", needed: 50, available: 40 }],
    });
  });

  it("50 kits with the enamel mug is valid: $29.50 a kit, $1,475", () => {
    const r = validateConfiguration(input(eventKits, 50, sel("MUG-ENAMEL")));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.priced.perBoxMinor).toBe(2950);
      expect(r.priced.totalMinor).toBe(147500);
    }
  });

  it("the engine itself proposes the mug when the bottle runs out at 50", () => {
    const base = input(eventKits, 50, sel("BOTTLE-INSULATED"));
    const { alternatives } = proposeAlternatives(base);
    expect(alternatives.some((a) => a.slotId === "drink" && a.toSku === "MUG-ENAMEL")).toBe(true);
  });

  it("carries the logo on the lanyard slot, and the logo rule allows png and svg", () => {
    const template = boxTemplateRuleSchema.parse(eventKits.rules.find((r) => r.key === "box_template")!.value);
    expect(template.slots.find((s) => s.id === "lanyard")?.customization).toBe("logo");
    expect(eventKits.rules.find((r) => r.key === "logo_print")!.value).toMatchObject({ formats: ["png", "svg"] });
  });
});
