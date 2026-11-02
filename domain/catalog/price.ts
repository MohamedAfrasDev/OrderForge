import { mulInt, sum } from "@/lib/money";
import type { Catalog, Configuration, PricedConfiguration, PricedLine } from "./types";

/**
 * The only place a price rule could ever go. v1 is a plain sum: no discounts, fees or tax.
 * Expects a configuration that already passed validation; an unknown slot or SKU is a programmer bug and throws.
 * Lines follow the catalog's slot order.
 */
export function calculateQuote(configuration: Configuration, catalog: Catalog): PricedConfiguration {
  const lines: PricedLine[] = [];
  for (const slot of catalog.slots) {
    const sku = configuration.selections[slot.id];
    if (sku === undefined) continue;
    const product = catalog.products.find((p) => p.sku === sku);
    if (!product) throw new Error(`calculateQuote: unknown SKU ${sku} in slot ${slot.id}`);
    lines.push({
      slotId: slot.id,
      sku: product.sku,
      name: product.name,
      unitPriceMinor: product.unitPriceMinor,
      quantity: slot.quantity,
    });
  }
  for (const slotId of Object.keys(configuration.selections)) {
    if (!catalog.slots.some((s) => s.id === slotId)) throw new Error(`calculateQuote: unknown slot ${slotId}`);
  }

  const perBoxMinor = sum(lines.map((l) => mulInt(l.unitPriceMinor, l.quantity)));
  return { lines, perBoxMinor, boxCount: configuration.boxCount, totalMinor: mulInt(perBoxMinor, configuration.boxCount), currency: "USD" };
}
