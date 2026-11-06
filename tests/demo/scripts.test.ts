// The prepared requests are looked up by store and key only, are ordinary customer text, and lead to the figures the engine produces.
import { describe, expect, it } from "vitest";
import { boxTemplateRuleSchema, type Catalog, type Stock } from "@/domain/catalog";
import { demoScript, demoScriptsFor, demoSlugs } from "@/domain/demo/scripts";
import { claimsIn } from "@/lib/claims";
import { cents } from "@/lib/money";
import { proposeForRequest } from "@/services/agent-requests/propose";
import { shops } from "../../supabase/seed/fixtures";

function snapshotOf(slug: string): { catalog: Catalog; stock: Stock } {
  const shop = shops.find((s) => s.merchant.slug === slug)!;
  const template = boxTemplateRuleSchema.parse(shop.rules.find((r) => r.key === "box_template")!.value);
  const lead = (shop.rules.find((r) => r.key === "production_lead_days")!.value as { days: number }).days;
  return {
    catalog: {
      products: shop.products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, category: p.category, unitPriceMinor: cents(p.unit_price_minor), isFood: p.is_food, active: true })),
      slots: template.slots,
      rules: { productionLeadDays: lead },
    },
    stock: Object.fromEntries(shop.stock.map((s) => [s.product_id, s.on_hand - s.reserved])),
  };
}

const ask = (slug: string, boxCount: number) => {
  const { catalog, stock } = snapshotOf(slug);
  return proposeForRequest({ body: { boxCount, noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000 }, catalog, stock, today: "2026-11-06" });
};

describe("lookup", () => {
  it("finds the prepared request of each demo shop", () => {
    expect(demoScript("demo-gift-boxes", "welcome-20")?.label).toBe("20 welcome boxes");
    expect(demoScript("demo-event-kits", "welcome-20")?.label).toBe("20 welcome kits");
  });

  it("returns nothing for an unknown store, an unknown key, a wrong type, or a name every object has", () => {
    for (const [slug, key] of [
      ["nope", "welcome-20"], ["demo-gift-boxes", "nope"], ["demo-gift-boxes", ""], ["", "welcome-20"],
      ["constructor", "welcome-20"], ["__proto__", "welcome-20"], ["demo-gift-boxes", "constructor"], ["demo-gift-boxes", "toString"],
      [undefined, "welcome-20"], ["demo-gift-boxes", undefined], [1, 2], [null, null], [["demo-gift-boxes"], "welcome-20"],
    ] as Array<[unknown, unknown]>) {
      expect(demoScript(slug, key), `${String(slug)} / ${String(key)}`).toBeNull();
    }
  });

  it("lists the stores and their requests in a fixed order", () => {
    expect(demoSlugs()).toEqual(["demo-gift-boxes", "demo-event-kits"]);
    expect(demoScriptsFor("demo-gift-boxes").map((s) => s.key)).toEqual(["welcome-20"]);
    expect(demoScriptsFor("nope")).toEqual([]);
    expect(demoScriptsFor("constructor")).toEqual([]);
  });

  it("every script belongs to a shop the seed creates", () => {
    const seeded = shops.map((s) => s.merchant.slug);
    for (const slug of demoSlugs()) expect(seeded).toContain(slug);
  });
});

describe("the text", () => {
  const all = demoSlugs().flatMap((slug) => demoScriptsFor(slug).map((s) => ({ slug, s })));

  it.each(all)("$slug / $s.key reads like a customer: plain, short, no digits except the amounts, no system word", ({ s }) => {
    for (const text of [s.message, s.change.message]) {
      expect(text.length).toBeGreaterThan(10);
      expect(text.length).toBeLessThan(400);
      expect(text).not.toMatch(/[<>{}]|https?:|@|\bSKU\b|[A-Z]+_[A-Z_]+/);
      expect(claimsIn(text)).toEqual([]);
    }
  });

  it.each(all)("$slug / $s.key states the quantity, the no-food rule, the logo and the budget the engine is given", ({ s }) => {
    expect(s.message).toMatch(/\b20\b/);
    expect(s.message).toMatch(/no food/i);
    expect(s.message).toMatch(/logo/i);
    expect(s.message).toMatch(/\$40\b/);
    expect(s.change.message).toContain(String(s.change.boxCount));
  });
});

describe("the figures the engine gives for the prepared requests", () => {
  it("gift boxes: 20 fits at $35.00 a box and $700.00; 30 is blocked on the steel bottle (24 in stock) and the desk organizer is offered at $36.00 and $1,080.00", () => {
    const fits = ask("demo-gift-boxes", 20);
    expect(fits.status).toBe("VALID");
    expect(fits.proposals[0]).toMatchObject({ perBoxMinor: 3500, totalMinor: 70000, boxCount: 20 });
    const changed = ask("demo-gift-boxes", demoScript("demo-gift-boxes", "welcome-20")!.change.boxCount);
    expect(changed.status).toBe("BLOCKED");
    expect(changed.blockers).toEqual([{ code: "INSUFFICIENT_STOCK", sku: "BOTTLE-STEEL", needed: 30, available: 24 }]);
    expect(changed.proposals.find((p) => p.kind === "SWAP")).toMatchObject({ perBoxMinor: 3600, totalMinor: 108000, swap: { fromSku: "BOTTLE-STEEL", toSku: "ORGANIZER-DESK" } });
  });

  it("event kits: 20 fits at $33.50 and $670.00; 50 is blocked on the insulated bottle (40 in stock) and the enamel mug is offered at $29.50 and $1,475.00", () => {
    const fits = ask("demo-event-kits", 20);
    expect(fits.status).toBe("VALID");
    expect(fits.proposals[0]).toMatchObject({ perBoxMinor: 3350, totalMinor: 67000, boxCount: 20 });
    const changed = ask("demo-event-kits", demoScript("demo-event-kits", "welcome-20")!.change.boxCount);
    expect(changed.status).toBe("BLOCKED");
    expect(changed.blockers).toEqual([{ code: "INSUFFICIENT_STOCK", sku: "BOTTLE-INSULATED", needed: 50, available: 40 }]);
    expect(changed.proposals.find((p) => p.kind === "SWAP")).toMatchObject({ perBoxMinor: 2950, totalMinor: 147500, swap: { fromSku: "BOTTLE-INSULATED", toSku: "MUG-ENAMEL" } });
  });
});
