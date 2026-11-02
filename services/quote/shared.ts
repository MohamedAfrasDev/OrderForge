import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  DEFAULT_VALIDITY_HOURS,
  buildQuoteSnapshot,
  storedConditionsSchema,
  storedLinesSchema,
  type Condition,
  type QuoteSnapshot,
  type QuoteStatus,
} from "@/domain/quote";
import type { AuditInsert } from "@/lib/audit";
import { cents, mulInt, sum } from "@/lib/money";

/** `now` and `correlationId` are passed in by the caller (route or action); services never read the clock. */
export type ServiceContext = { now: string; correlationId: string };

export type SystemActor = { kind: "system" };
export type MerchantActor = { kind: "merchant"; userId: string; merchantId: string };
export type Actor = SystemActor | MerchantActor;

export const actorName = (actor: Actor): string => (actor.kind === "system" ? "system" : `merchant:${actor.userId}`);

export const QUOTE_COLUMNS =
  "id, inquiry_id, version, status, requirement_version_id, lines, total_minor, quote_hash, pending_conditions, published_at";

export type QuoteRow = {
  id: string;
  inquiry_id: string;
  version: number;
  status: QuoteStatus;
  requirement_version_id: string | null;
  lines: unknown;
  total_minor: number;
  quote_hash: string | null;
  pending_conditions: unknown;
  published_at: string | null;
};

export function auditInsertFor(db: SupabaseClient): AuditInsert {
  return async (row) => {
    const { error } = await db.from("audit_events").insert(row);
    if (error) throw new Error(`audit insert: ${error.message}`);
  };
}

/** The quote row and the merchant that owns its inquiry, or null when there is no such quote. */
export async function loadQuote(db: SupabaseClient, quoteId: string): Promise<{ quote: QuoteRow; merchantId: string } | null> {
  const found = await db.from("quote_versions").select(QUOTE_COLUMNS).eq("id", quoteId).maybeSingle();
  if (found.error) throw new Error(`load quote: ${found.error.message}`);
  if (!found.data) return null;
  const quote = found.data as unknown as QuoteRow;
  const inquiry = await db.from("inquiries").select("merchant_id").eq("id", quote.inquiry_id).single();
  if (inquiry.error) throw new Error(`load inquiry: ${inquiry.error.message}`);
  return { quote, merchantId: inquiry.data.merchant_id as string };
}

export async function setInquiryStatus(db: SupabaseClient, inquiryId: string, status: string): Promise<void> {
  const { error } = await db.from("inquiries").update({ status }).eq("id", inquiryId);
  if (error) throw new Error(`set inquiry status: ${error.message}`);
}

const validityRuleSchema = z.strictObject({ hours: z.number().int().min(1).max(720) });

/** The merchant rule `quote_validity_hours` ({ "hours": 72 }); 72 when the merchant has not set one. */
export async function loadValidityHours(db: SupabaseClient, merchantId: string): Promise<number> {
  const { data, error } = await db
    .from("business_rules")
    .select("value")
    .eq("merchant_id", merchantId)
    .eq("key", "quote_validity_hours")
    .maybeSingle();
  if (error) throw new Error(`load quote_validity_hours: ${error.message}`);
  if (!data) return DEFAULT_VALIDITY_HOURS;
  const parsed = validityRuleSchema.safeParse(data.value);
  if (!parsed.success) throw new Error('business rule "quote_validity_hours" is malformed');
  return parsed.data.hours;
}

export function parseConditions(raw: unknown): Condition[] | null {
  const parsed = storedConditionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Rebuilds the exact object that is hashed from a stored row. Returns null when the row does not fit the stored
 * shapes or is internally inconsistent (lines that do not add up), so callers can treat it as untrustworthy.
 */
export function snapshotFromRow(quote: QuoteRow, merchantId: string): QuoteSnapshot | null {
  const lines = storedLinesSchema.safeParse(quote.lines);
  const conditions = parseConditions(quote.pending_conditions);
  if (!lines.success || !conditions) return null;

  const { boxCount, perBoxMinor, lines: priced } = lines.data;
  const fromLines = sum(priced.map((l) => mulInt(l.unitPriceMinor, l.quantity)));
  const total = mulInt(perBoxMinor, boxCount);
  if (fromLines !== perBoxMinor || total !== quote.total_minor) return null;

  return buildQuoteSnapshot({
    merchantId,
    inquiryId: quote.inquiry_id,
    version: quote.version,
    requirementVersionId: quote.requirement_version_id,
    priced: { lines: priced, perBoxMinor, boxCount, totalMinor: cents(quote.total_minor), currency: "USD" },
    conditions,
  });
}
