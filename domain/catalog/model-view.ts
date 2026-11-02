import type { Cents } from "@/lib/money";
import type { Catalog, Slot } from "./types";

export type ModelProduct = { sku: string; name: string; category: string; isFood: boolean; unitPriceMinor: Cents };

export type ModelCatalogView = {
  products: ModelProduct[];
  slots: Slot[];
  rules: Catalog["rules"];
};

/**
 * What the model may see. Names, SKUs, categories, food flags, prices and the template; never stock
 * counts or internal ids. Inactive products are left out so the model is never shown something unsellable.
 */
export function catalogForModel(catalog: Catalog): ModelCatalogView {
  const active = new Set(catalog.products.filter((p) => p.active).map((p) => p.sku));
  return {
    products: catalog.products
      .filter((p) => p.active)
      .map((p) => ({ sku: p.sku, name: p.name, category: p.category, isFood: p.isFood, unitPriceMinor: p.unitPriceMinor })),
    slots: catalog.slots.map((s) => ({ ...s, allowedSkus: s.allowedSkus.filter((sku) => active.has(sku)) })),
    rules: { ...catalog.rules },
  };
}
