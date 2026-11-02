import type { ProductQuantity } from "./types";

export type StockRow = { productId: string; onHand: number; reserved: number };

export type Discrepancy =
  | { code: "RESERVED_EXCEEDS_ON_HAND"; productId: string; onHand: number; reserved: number }
  | { code: "RESERVED_MISMATCH"; productId: string; reserved: number; expected: number }
  | { code: "ON_HAND_MISMATCH"; productId: string; onHand: number; expected: number };

export type InvariantOptions = {
  /** on_hand before any reservation was committed. With it, on_hand must have fallen by exactly the committed quantity. */
  baselineOnHand?: Readonly<Record<string, number>>;
  /** The lines of COMMITTED reservations. */
  committedLines?: readonly ProductQuantity[];
};

const sumByProduct = (lines: readonly ProductQuantity[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.productId, (out.get(l.productId) ?? 0) + l.quantity);
  return out;
};

/**
 * Is stock consistent with the reservations? `reserved` on every product must equal the quantity on live
 * reservations (HELD, PAYMENT_IN_FLIGHT, AWAITING_CONFIRMATION, REVIEW_REQUIRED), and never exceed `on_hand`.
 * An empty result means consistent. Results are ordered by product id, then by code.
 */
export function stockInvariant(
  stock: readonly StockRow[],
  liveLines: readonly ProductQuantity[],
  options: InvariantOptions = {},
): Discrepancy[] {
  const live = sumByProduct(liveLines);
  const committed = sumByProduct(options.committedLines ?? []);
  const rows = new Map(stock.map((s) => [s.productId, s]));
  const ids = new Set<string>([...rows.keys(), ...live.keys()]);

  const found: Discrepancy[] = [];
  for (const productId of [...ids].sort()) {
    const row = rows.get(productId);
    const reserved = row?.reserved ?? 0;
    if (row && row.reserved > row.onHand) {
      found.push({ code: "RESERVED_EXCEEDS_ON_HAND", productId, onHand: row.onHand, reserved: row.reserved });
    }
    const expected = live.get(productId) ?? 0;
    if (reserved !== expected) found.push({ code: "RESERVED_MISMATCH", productId, reserved, expected });

    const baseline = options.baselineOnHand?.[productId];
    if (row && baseline !== undefined) {
      const expectedOnHand = baseline - (committed.get(productId) ?? 0);
      if (row.onHand !== expectedOnHand) found.push({ code: "ON_HAND_MISMATCH", productId, onHand: row.onHand, expected: expectedOnHand });
    }
  }
  return found;
}
