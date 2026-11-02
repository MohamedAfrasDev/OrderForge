import type { SupabaseClient } from "@supabase/supabase-js";
import { expiresAt, isExpired, quoteHash, renderTerms, type Condition } from "@/domain/quote";
import type { VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { sha256Hex } from "@/lib/hash";
import { QUOTE_COLUMNS, loadValidityHours, snapshotFromRow, type QuoteRow } from "./shared";

/** Everything a customer may see of a quote. No merchant id, stock figure or internal id other than the quote's own. */
export type CustomerQuoteView = {
  quoteId: string;
  version: number;
  status: "PUBLISHED" | "ACCEPTED";
  /** The hash the customer accepts. The server compares it with its own recomputation. */
  hash: string;
  /** A published quote past its validity window. Accepting is refused; the row itself is unchanged. */
  expired: boolean;
  expiresAt: string | null;
  acceptedAt: string | null;
  boxCount: number;
  perBoxMinor: number;
  totalMinor: number;
  currency: "USD";
  lines: Array<{ name: string; quantity: number; unitPriceMinor: number }>;
  conditions: Condition[];
  terms: string;
};

/**
 * The verified inquiry's live quote, or null. Only PUBLISHED and ACCEPTED quotes are ever returned: drafts (including
 * ones held for merchant review) are merchant-only. A quote whose stored hash is not the hash of its content is not shown.
 */
export async function readCustomerQuote(
  db: SupabaseClient,
  inquiryId: VerifiedInquiryId,
  now: string,
): Promise<CustomerQuoteView | null> {
  const found = await db
    .from("quote_versions")
    .select(QUOTE_COLUMNS)
    .eq("inquiry_id", inquiryId)
    .in("status", ["PUBLISHED", "ACCEPTED"])
    .limit(1)
    .maybeSingle();
  if (found.error) throw new Error(`read quote: ${found.error.message}`);
  if (!found.data) return null;
  const quote = found.data as unknown as QuoteRow;

  const inquiry = await db.from("inquiries").select("merchant_id").eq("id", inquiryId).single();
  if (inquiry.error) throw new Error(`read inquiry: ${inquiry.error.message}`);
  const merchantId = inquiry.data.merchant_id as string;

  const snapshot = snapshotFromRow(quote, merchantId);
  if (!snapshot || quote.quote_hash === null || quoteHash(snapshot, sha256Hex) !== quote.quote_hash) return null;

  const status = quote.status as "PUBLISHED" | "ACCEPTED";
  let acceptedAt: string | null = null;
  if (status === "ACCEPTED") {
    const approval = await db.from("approvals").select("approved_at").eq("quote_version_id", quote.id).maybeSingle();
    if (approval.error) throw new Error(`read approval: ${approval.error.message}`);
    acceptedAt = approval.data ? new Date(approval.data.approved_at as string).toISOString() : null;
  }

  const validityHours = await loadValidityHours(db, merchantId);
  const published = status === "PUBLISHED";

  return {
    quoteId: quote.id,
    version: quote.version,
    status,
    hash: quote.quote_hash,
    expired: published && isExpired(quote.published_at!, validityHours, now),
    expiresAt: published ? expiresAt(quote.published_at!, validityHours) : null,
    acceptedAt,
    boxCount: snapshot.boxCount,
    perBoxMinor: snapshot.perBoxMinor,
    totalMinor: snapshot.totalMinor,
    currency: snapshot.currency,
    lines: snapshot.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
    conditions: snapshot.conditions,
    terms: renderTerms(snapshot),
  };
}
