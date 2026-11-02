import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { boxTemplateRuleSchema, type Catalog, type Product, type Stock } from "@/domain/catalog";
import { cents } from "@/lib/money";

/** The merchant's data is malformed or incomplete. A programmer or seed problem, never a customer outcome. */
export class CatalogLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogLoadError";
  }
}

export type CatalogSnapshot = { catalog: Catalog; stock: Stock };

const leadDaysRuleSchema = z.strictObject({ days: z.number().int().min(0) });
const minOrderRuleSchema = z.strictObject({ quantity: z.number().int().min(1) });

type ProductRow = {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit_price_minor: number;
  is_food: boolean;
  active: boolean;
};

function parseRule<T>(key: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CatalogLoadError(`business rule "${key}" is malformed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}

/**
 * Reads one merchant's products, stock and rules and returns what the pure engine needs.
 * available = on_hand - reserved. Every query is scoped to the merchant; the template is validated with Zod.
 */
export async function loadCatalogSnapshot(db: SupabaseClient, merchantId: string): Promise<CatalogSnapshot> {
  const productsResult = await db
    .from("products")
    .select("id, sku, name, category, unit_price_minor, is_food, active")
    .eq("merchant_id", merchantId)
    .order("sku");
  if (productsResult.error) throw new Error(`load products: ${productsResult.error.message}`);
  const rows = (productsResult.data ?? []) as ProductRow[];

  const stockResult = rows.length
    ? await db.from("stock").select("product_id, on_hand, reserved").in("product_id", rows.map((r) => r.id))
    : { data: [], error: null };
  if (stockResult.error) throw new Error(`load stock: ${stockResult.error.message}`);

  const rulesResult = await db
    .from("business_rules")
    .select("key, value")
    .eq("merchant_id", merchantId)
    .in("key", ["box_template", "production_lead_days", "min_order_quantity"]);
  if (rulesResult.error) throw new Error(`load business rules: ${rulesResult.error.message}`);
  const rules = new Map((rulesResult.data ?? []).map((r) => [r.key as string, r.value as unknown]));

  const products: Product[] = rows.map((r) => ({
    id: r.id,
    sku: r.sku,
    name: r.name,
    category: r.category,
    unitPriceMinor: cents(Number(r.unit_price_minor)),
    isFood: r.is_food,
    active: r.active,
  }));

  const stock: Stock = Object.fromEntries(products.map((p) => [p.id, 0]));
  for (const s of (stockResult.data ?? []) as { product_id: string; on_hand: number; reserved: number }[]) {
    stock[s.product_id] = s.on_hand - s.reserved;
  }

  if (!rules.has("box_template")) throw new CatalogLoadError(`merchant ${merchantId} has no "box_template" business rule`);
  const template = parseRule("box_template", boxTemplateRuleSchema, rules.get("box_template"));
  const skus = new Set(products.map((p) => p.sku));
  for (const slot of template.slots) {
    for (const sku of slot.allowedSkus) {
      if (!skus.has(sku)) throw new CatalogLoadError(`business rule "box_template" slot "${slot.id}" names SKU "${sku}", which this merchant does not sell`);
    }
  }

  const lead = rules.has("production_lead_days") ? parseRule("production_lead_days", leadDaysRuleSchema, rules.get("production_lead_days")) : undefined;
  const min = rules.has("min_order_quantity") ? parseRule("min_order_quantity", minOrderRuleSchema, rules.get("min_order_quantity")) : undefined;

  return {
    catalog: {
      products,
      slots: template.slots,
      rules: { productionLeadDays: lead?.days ?? 0, ...(min ? { minOrderQuantity: min.quantity } : {}) },
    },
    stock,
  };
}
