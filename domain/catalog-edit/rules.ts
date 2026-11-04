/** The part of a box template these rules need. */
export type TemplateSlot = { id: string; label: string; allowedSkus: readonly string[] };
export type ProductState = { sku: string; active: boolean };

export type DeactivationCheck = { ok: true } | { ok: false; slotLabels: string[] };

/**
 * A product may be switched off unless it is the last active product of a part of the box: that part would have nothing to sell, and no box
 * could be built. `products` is every product of the shop. Returns the labels of the parts that would be left empty.
 */
export function checkDeactivation(slots: readonly TemplateSlot[], products: readonly ProductState[], sku: string): DeactivationCheck {
  const active = new Set(products.filter((p) => p.active).map((p) => p.sku));
  const emptied = slots.filter((s) => s.allowedSkus.includes(sku) && !s.allowedSkus.some((other) => other !== sku && active.has(other)));
  return emptied.length === 0 ? { ok: true } : { ok: false, slotLabels: emptied.map((s) => s.label) };
}

export type StockCheck = { ok: true } | { ok: false; held: number };

/** Stock on hand may not drop below what is held for customers. */
export function checkStockChange(newOnHand: number, held: number): StockCheck {
  return newOnHand >= held ? { ok: true } : { ok: false, held };
}

export type SlotsCheck = { ok: true } | { ok: false; reason: "NO_SLOT" | "UNKNOWN_SLOT"; unknown: string[] };

/** A new product must go in at least one part of the box, and each part must exist in the template. */
export function checkNewProductSlots(slotIds: readonly string[], slots: readonly TemplateSlot[]): SlotsCheck {
  if (slotIds.length === 0) return { ok: false, reason: "NO_SLOT", unknown: [] };
  const known = new Set(slots.map((s) => s.id));
  const unknown = slotIds.filter((id) => !known.has(id));
  return unknown.length === 0 ? { ok: true } : { ok: false, reason: "UNKNOWN_SLOT", unknown };
}

/** The template with `sku` added to the named parts. Every other part, and the order of everything, is kept; a SKU already there is not repeated. */
export function withSkuInSlots<T extends TemplateSlot>(slots: readonly T[], sku: string, slotIds: readonly string[]): T[] {
  return slots.map((s) => (slotIds.includes(s.id) && !s.allowedSkus.includes(sku) ? { ...s, allowedSkus: [...s.allowedSkus, sku] } : { ...s }));
}
