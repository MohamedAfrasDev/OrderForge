import { calculateQuote } from "./price";
import type { Alternative, ProposeOptions, ValidationInput } from "./types";
import { validateConfiguration } from "./validate";

export const DEFAULT_ALTERNATIVES_LIMIT = 5;
export const MAX_ALTERNATIVES_LIMIT = 20;

type Ranked = { alt: Alternative; slotIndex: number; allowedIndex: number };

/**
 * Single swaps inside one slot, to another product that slot allows, keeping everything else.
 * A candidate is kept only if validateConfiguration says it is valid, so the model can rank or explain
 * these but cannot add to them. At most (slots x allowed products) candidates are tried.
 *
 * Order: smallest absolute change in per-box price, then slot order, then the slot's allowed-list
 * order, then SKU. Slot order and allowed-list order are the merchant's template order.
 */
export function proposeAlternatives(
  input: ValidationInput,
  options: ProposeOptions = {},
): { alternatives: Alternative[]; considered: number } {
  const limit = options.limit ?? DEFAULT_ALTERNATIVES_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer >= 1");
  const cap = Math.min(limit, MAX_ALTERNATIVES_LIMIT);

  const { configuration, catalog } = input;
  const originalPerBox = originalPerBoxMinor(input);
  const ranked: Ranked[] = [];
  let considered = 0;

  catalog.slots.forEach((slot, slotIndex) => {
    if (!Object.hasOwn(configuration.selections, slot.id)) return;
    const fromSku = configuration.selections[slot.id]!;
    slot.allowedSkus.forEach((toSku, allowedIndex) => {
      if (toSku === fromSku) return;
      considered += 1;
      const candidate = { ...configuration, selections: { ...configuration.selections, [slot.id]: toSku } };
      const result = validateConfiguration({ ...input, configuration: candidate });
      if (!result.ok) return;
      ranked.push({
        alt: {
          slotId: slot.id,
          fromSku,
          toSku,
          perBoxDeltaMinor: originalPerBox === undefined ? 0 : result.priced.perBoxMinor - originalPerBox,
          priced: result.priced,
        },
        slotIndex,
        allowedIndex,
      });
    });
  });

  ranked.sort(
    (a, b) =>
      Math.abs(a.alt.perBoxDeltaMinor) - Math.abs(b.alt.perBoxDeltaMinor) ||
      a.slotIndex - b.slotIndex ||
      a.allowedIndex - b.allowedIndex ||
      (a.alt.toSku < b.alt.toSku ? -1 : a.alt.toSku > b.alt.toSku ? 1 : 0),
  );
  return { alternatives: ranked.slice(0, cap).map((r) => r.alt), considered };
}

/** Per-box price of the box as given, or undefined if it cannot be priced (a slot unfilled or unknown). */
function originalPerBoxMinor({ configuration, catalog }: ValidationInput) {
  const known = new Set(catalog.products.map((p) => p.sku));
  const selections: Record<string, string> = {};
  for (const slot of catalog.slots) {
    const sku = Object.hasOwn(configuration.selections, slot.id) ? configuration.selections[slot.id]! : undefined;
    if (sku === undefined || !known.has(sku)) return undefined;
    selections[slot.id] = sku;
  }
  return calculateQuote({ boxCount: 1, selections }, catalog).perBoxMinor;
}
