import { z } from "zod";
import type { QuoteSnapshot } from "@/domain/quote";
import { WORKSHEET_SCHEMA_TAG, type Worksheet, type WorksheetFacts } from "./types";

const text = z.string().min(1).max(500);

/** The stored worksheet, strict: an unknown key or tag is rejected. */
export const worksheetSchema = z.strictObject({
  schema: z.literal(WORKSHEET_SCHEMA_TAG),
  quote: z.strictObject({ version: z.number().int().min(1), hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  purchaseId: z.uuid(),
  inquiryId: z.uuid(),
  boxCount: z.number().int().min(1),
  perBox: z.array(z.strictObject({ slotId: text, sku: text, name: text, quantityPerBox: z.number().int().min(1) })).min(1),
  pick: z.array(z.strictObject({ sku: text, name: text, quantity: z.number().int().min(1) })).min(1),
  conditions: z.array(z.strictObject({ code: text, text, confirmed: z.boolean() })),
  fulfilment: z.strictObject({ method: z.literal("customer_pickup") }),
  productionLeadDays: z.number().int().min(0).max(365),
  readyBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paid: z.strictObject({ totalMinor: z.number().int().min(1), currency: z.literal("USD") }),
});

type SnapshotLike = Pick<QuoteSnapshot, "inquiryId" | "version" | "boxCount" | "totalMinor" | "currency" | "conditions"> & {
  lines: ReadonlyArray<{ slotId: string; sku: string; name: string; quantity: number }>;
};

const DAY_MS = 86_400_000;

function readyByOf(createdAt: string, leadDays: number): string {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) throw new RangeError("createdAt must be an ISO timestamp");
  const dayStart = Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate());
  return new Date(dayStart + leadDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The worksheet for one paid purchase, built only from the accepted snapshot and the facts passed in: lines per box, what to
 * pick in total (quantity per box times boxes, summed per SKU, so a product in two slots counts twice), the conditions and
 * which the merchant confirmed, the pickup method, the ready-by day and the total paid. Deterministic, no clock, no catalog
 * reads, and nothing about the payer or PayPal. A malformed snapshot or fact is a programmer bug and throws.
 */
export function buildWorksheet(snapshot: SnapshotLike, facts: WorksheetFacts): Worksheet {
  if (!Number.isSafeInteger(snapshot.boxCount) || snapshot.boxCount < 1) throw new RangeError("boxCount must be a positive integer");
  if (snapshot.lines.length === 0) throw new RangeError("a quote has at least one line");
  if (!Number.isInteger(facts.productionLeadDays) || facts.productionLeadDays < 0 || facts.productionLeadDays > 365) {
    throw new RangeError("productionLeadDays must be an integer from 0 to 365");
  }
  if (!/^[0-9a-f]{64}$/.test(facts.quoteHash)) throw new RangeError("quoteHash must be a SHA-256 hex digest");
  const readyBy = readyByOf(facts.createdAt, facts.productionLeadDays);

  const totals = new Map<string, { name: string; quantity: number }>();
  for (const line of snapshot.lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) throw new RangeError(`quantity of ${line.sku} must be a positive integer`);
    const sum = (totals.get(line.sku)?.quantity ?? 0) + line.quantity * snapshot.boxCount;
    if (!Number.isSafeInteger(sum)) throw new RangeError("quantity overflow");
    totals.set(line.sku, { name: line.name, quantity: sum });
  }

  const confirmed = new Set(facts.confirmedConditions);
  return {
    schema: WORKSHEET_SCHEMA_TAG,
    quote: { version: snapshot.version, hash: facts.quoteHash },
    purchaseId: facts.purchaseId,
    inquiryId: snapshot.inquiryId,
    boxCount: snapshot.boxCount,
    perBox: snapshot.lines.map((l) => ({ slotId: l.slotId, sku: l.sku, name: l.name, quantityPerBox: l.quantity })),
    pick: [...totals.entries()]
      .map(([sku, t]) => ({ sku, name: t.name, quantity: t.quantity }))
      .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)),
    conditions: snapshot.conditions.map((c) => ({ code: c.code, text: c.text, confirmed: confirmed.has(c.code) })),
    fulfilment: { method: facts.fulfilmentMethod },
    productionLeadDays: facts.productionLeadDays,
    readyBy,
    paid: { totalMinor: snapshot.totalMinor, currency: snapshot.currency },
  };
}
