import { addDays, isCalendarDate } from "./dates";
import type { Cents } from "@/lib/money";
import { calculateQuote } from "./price";
import type { Blocker, Product, ValidationInput, ValidationResult } from "./types";

function checkStructure({ configuration, catalog }: ValidationInput): Blocker[] {
  const blockers: Blocker[] = [];
  const { boxCount, selections } = configuration;
  if (!Number.isInteger(boxCount) || boxCount < 1) blockers.push({ code: "INVALID_QUANTITY", boxCount });

  const slotIds = new Set(catalog.slots.map((s) => s.id));
  // Sorted so the result does not depend on the key order of the input object.
  for (const slotId of Object.keys(selections).sort()) {
    if (!slotIds.has(slotId)) blockers.push({ code: "UNKNOWN_SLOT", slotId });
  }
  for (const slot of catalog.slots) {
    if (!Object.hasOwn(selections, slot.id)) blockers.push({ code: "SLOT_NOT_FILLED", slotId: slot.id });
  }
  return blockers;
}

function checkProducts({ configuration, catalog }: ValidationInput): Blocker[] {
  const blockers: Blocker[] = [];
  const bySku = new Map<string, Product>(catalog.products.map((p) => [p.sku, p]));
  for (const slot of catalog.slots) {
    if (!Object.hasOwn(configuration.selections, slot.id)) continue;
    const sku = configuration.selections[slot.id]!;
    const product = bySku.get(sku);
    if (!product) {
      blockers.push({ code: "UNKNOWN_PRODUCT", slotId: slot.id, sku });
      continue;
    }
    if (!product.active) blockers.push({ code: "INACTIVE_PRODUCT", slotId: slot.id, sku });
    if (!slot.allowedSkus.includes(sku)) blockers.push({ code: "PRODUCT_NOT_ALLOWED_IN_SLOT", slotId: slot.id, sku });
  }
  return blockers;
}

function checkConstraints({ configuration, catalog, requirements }: ValidationInput): Blocker[] {
  const blockers: Blocker[] = [];
  const bySku = new Map<string, Product>(catalog.products.map((p) => [p.sku, p]));
  const filled = catalog.slots.filter((s) => Object.hasOwn(configuration.selections, s.id));

  if (requirements.noFood) {
    for (const slot of filled) {
      const sku = configuration.selections[slot.id]!;
      if (bySku.get(sku)?.isFood) blockers.push({ code: "FOOD_NOT_ALLOWED", slotId: slot.id, sku });
    }
  }
  if (requirements.logoRequired && !filled.some((s) => s.customization === "logo")) {
    blockers.push({ code: "LOGO_NOT_COVERED" });
  }
  const { boxCount } = configuration;
  const minimum = catalog.rules.minOrderQuantity;
  // An invalid count is already reported as INVALID_QUANTITY; do not pile a second blocker on it.
  if (minimum !== undefined && Number.isInteger(boxCount) && boxCount >= 1 && boxCount < minimum) {
    blockers.push({ code: "BELOW_MIN_QUANTITY", boxCount, minimum });
  }
  return blockers;
}

function checkStock({ configuration, catalog, stock }: ValidationInput): Blocker[] {
  const { boxCount } = configuration;
  if (!Number.isInteger(boxCount) || boxCount < 1) return [];
  const bySku = new Map<string, Product>(catalog.products.map((p) => [p.sku, p]));
  // Needed is summed per product across slots, so a product used in two slots counts twice. Map keeps slot order.
  const needed = new Map<string, number>();
  for (const slot of catalog.slots) {
    if (!Object.hasOwn(configuration.selections, slot.id)) continue;
    const sku = configuration.selections[slot.id]!;
    if (!bySku.has(sku)) continue;
    needed.set(sku, (needed.get(sku) ?? 0) + slot.quantity * boxCount);
  }
  const blockers: Blocker[] = [];
  for (const [sku, amount] of needed) {
    const available = stock[bySku.get(sku)!.id] ?? 0;
    if (amount > available) blockers.push({ code: "INSUFFICIENT_STOCK", sku, needed: amount, available });
  }
  return blockers;
}

/** Per-box price, or undefined while some template slot is unfilled or holds an unknown product (no price exists yet). */
function perBoxIfPriceable({ configuration, catalog }: ValidationInput): Cents | undefined {
  const known = new Set(catalog.products.map((p) => p.sku));
  const selections: Record<string, string> = {};
  for (const slot of catalog.slots) {
    const sku = Object.hasOwn(configuration.selections, slot.id) ? configuration.selections[slot.id]! : undefined;
    if (sku === undefined || !known.has(sku)) return undefined;
    selections[slot.id] = sku;
  }
  return calculateQuote({ boxCount: 1, selections }, catalog).perBoxMinor;
}

function checkBudget(input: ValidationInput): Blocker[] {
  const max = input.requirements.maxPricePerBoxMinor;
  if (max === undefined) return [];
  const perBoxMinor = perBoxIfPriceable(input);
  return perBoxMinor !== undefined && perBoxMinor > max ? [{ code: "OVER_BUDGET", perBoxMinor, maxMinor: max }] : [];
}

function checkDate({ requirements, catalog, today }: ValidationInput): Blocker[] {
  const requested = requirements.requestedPickupDate;
  if (requested === undefined) return [];
  const earliest = addDays(today, catalog.rules.productionLeadDays);
  // Both are YYYY-MM-DD, so string order is calendar order.
  return !isCalendarDate(requested) || requested < earliest ? [{ code: "UNSUPPORTED_DATE", requested, earliest }] : [];
}

/** Pure; business outcomes are returned as data, never thrown. Blockers come in a fixed order: structure, product, constraint, stock, price, date. */
export function validateConfiguration(input: ValidationInput): ValidationResult {
  const blockers: Blocker[] = [
    ...checkStructure(input),
    ...checkProducts(input),
    ...checkConstraints(input),
    ...checkStock(input),
    ...checkBudget(input),
    ...checkDate(input),
  ];
  return blockers.length > 0
    ? { ok: false, blockers }
    : { ok: true, priced: calculateQuote(input.configuration, input.catalog) };
}
