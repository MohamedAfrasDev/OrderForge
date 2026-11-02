import type { SupabaseClient } from "@supabase/supabase-js";
import { gateForPublish, storedLinesSchema, type Condition } from "@/domain/quote";
import { QUOTE_COLUMNS, parseConditions, type QuoteRow } from "./shared";

export type ReviewDraft = {
  quoteId: string;
  version: number;
  inquiryId: string;
  createdAt: string;
  /** Null when the stored lines do not fit the expected shape; the draft is still listed so it can be withdrawn. */
  boxCount: number | null;
  perBoxMinor: number | null;
  totalMinor: number;
  conditions: Condition[];
  /** An unresolved mandatory condition, or the inquiry was sent to review: a person has to decide. */
  needsDecision: boolean;
  readable: boolean;
};

type DraftRow = QuoteRow & { created_at: string; inquiries: { merchant_id: string; status: string } | { merchant_id: string; status: string }[] };

/**
 * The merchant's draft quotes, newest first. Pass the merchant's own session client to read under row level
 * security (other merchants' rows are then invisible even if the wrong id is passed), or the service client
 * with the verified merchant id. Writes never happen here.
 */
export async function listReviewDrafts(db: SupabaseClient, merchantId: string, limit = 50): Promise<ReviewDraft[]> {
  const found = await db
    .from("quote_versions")
    .select(`${QUOTE_COLUMNS}, created_at, inquiries!inner(merchant_id, status)`)
    .eq("status", "DRAFT")
    .eq("inquiries.merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (found.error) throw new Error(`list drafts: ${found.error.message}`);

  return ((found.data ?? []) as unknown as DraftRow[]).map((row) => {
    const inquiry = Array.isArray(row.inquiries) ? row.inquiries[0]! : row.inquiries;
    const lines = storedLinesSchema.safeParse(row.lines);
    const conditions = parseConditions(row.pending_conditions) ?? [];
    return {
      quoteId: row.id,
      version: row.version,
      inquiryId: row.inquiry_id,
      createdAt: row.created_at,
      boxCount: lines.success ? lines.data.boxCount : null,
      perBoxMinor: lines.success ? lines.data.perBoxMinor : null,
      totalMinor: row.total_minor,
      conditions,
      needsDecision: !gateForPublish(conditions).canAutoPublish || inquiry.status === "REVIEW_REQUIRED",
      readable: lines.success,
    };
  });
}
