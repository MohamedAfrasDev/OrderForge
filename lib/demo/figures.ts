// The figures /demo quotes for a shop's prepared request and for the follow-up that crosses its stock limit. Nothing here is typed in: the
// catalog and stock are the seed fixtures the database is seeded from, and every number is what the pricing engine returns for them.
import { boxTemplateRuleSchema, type Catalog, type Stock } from "@/domain/catalog";
import { demoScript } from "@/domain/demo/scripts";
import { cents } from "@/lib/money";
import { proposeForRequest } from "@/services/agent-requests/propose";
import { shops } from "../../supabase/seed/fixtures";

export type DemoFigures = {
  fits: { boxCount: number; perBoxMinor: number; totalMinor: number };
  /** The stock limit the follow-up runs into, in the shop's own words, and what code offers instead. */
  blocked: { boxCount: number; item: string; available: number; swapItem: string; swapPerBoxMinor: number; swapTotalMinor: number };
};

const EXAMPLE_TODAY = "2026-11-06";

function snapshotOf(slug: string): { catalog: Catalog; stock: Stock } | null {
  const shop = shops.find((s) => s.merchant.slug === slug);
  const rule = shop?.rules.find((r) => r.key === "box_template");
  if (!shop || !rule) return null;
  const lead = (shop.rules.find((r) => r.key === "production_lead_days")?.value as { days: number } | undefined)?.days ?? 0;
  return {
    catalog: {
      products: shop.products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, category: p.category, unitPriceMinor: cents(p.unit_price_minor), isFood: p.is_food, active: true })),
      slots: boxTemplateRuleSchema.parse(rule.value).slots,
      rules: { productionLeadDays: lead },
    },
    stock: Object.fromEntries(shop.stock.map((s) => [s.product_id, s.on_hand - s.reserved])),
  };
}

/** The figures for a shop's "welcome-20" request, or null when the shop has no prepared request or the engine does not give the expected story (a fit, then a stock block with one swap). */
export function demoFigures(slug: string): DemoFigures | null {
  const script = demoScript(slug, "welcome-20");
  const snap = snapshotOf(slug);
  if (!script || !snap) return null;
  const ask = (boxCount: number) => proposeForRequest({ body: { boxCount, noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000 }, ...snap, today: EXAMPLE_TODAY });

  const fit = ask(20);
  const box = fit.proposals[0];
  const change = ask(script.change.boxCount);
  const stockBlock = change.blockers.find((b) => b.code === "INSUFFICIENT_STOCK");
  const swap = change.proposals.find((p) => p.kind === "SWAP");
  if (fit.status !== "VALID" || !box || !stockBlock || stockBlock.code !== "INSUFFICIENT_STOCK" || !swap?.swap) return null;

  const nameOf = (sku: string) => snap.catalog.products.find((p) => p.sku === sku)?.name ?? sku;
  return {
    fits: { boxCount: box.boxCount, perBoxMinor: box.perBoxMinor, totalMinor: box.totalMinor },
    blocked: { boxCount: script.change.boxCount, item: nameOf(stockBlock.sku), available: stockBlock.available, swapItem: nameOf(swap.swap.toSku), swapPerBoxMinor: swap.perBoxMinor, swapTotalMinor: swap.totalMinor },
  };
}
