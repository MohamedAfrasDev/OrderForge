import type { QuoteSnapshot } from "@/domain/quote";
import type { ProductQuantity } from "./types";

type SnapshotLike = Pick<QuoteSnapshot, "boxCount"> & { lines: ReadonlyArray<{ sku: string; quantity: number }> };
type SkuMap = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

function productIdFor(map: SkuMap, sku: string): string | undefined {
  if (map instanceof Map) return map.get(sku);
  return Object.hasOwn(map, sku) ? (map as Readonly<Record<string, string>>)[sku] : undefined;
}

function assertPositiveInteger(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${what} must be a positive safe integer`);
}

/**
 * What one accepted quote needs from stock: line quantity x box count, summed per product (a product in two slots
 * counts twice). Sorted by product id, which is the order stock rows are locked in. An unknown SKU or a malformed
 * snapshot is a programmer bug and throws; it is never a customer outcome.
 */
export function requiredQuantities(snapshot: SnapshotLike, skuToProductId: SkuMap): ProductQuantity[] {
  assertPositiveInteger(snapshot.boxCount, "boxCount");
  if (snapshot.lines.length === 0) throw new RangeError("a quote has at least one line");

  const totals = new Map<string, number>();
  for (const line of snapshot.lines) {
    assertPositiveInteger(line.quantity, `quantity of ${line.sku}`);
    const productId = productIdFor(skuToProductId, line.sku);
    if (productId === undefined) throw new Error(`requiredQuantities: no product for SKU ${line.sku}`);
    const needed = line.quantity * snapshot.boxCount;
    const sum = (totals.get(productId) ?? 0) + needed;
    if (!Number.isSafeInteger(needed) || !Number.isSafeInteger(sum)) throw new RangeError("quantity overflow");
    totals.set(productId, sum);
  }

  return [...totals.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
}
