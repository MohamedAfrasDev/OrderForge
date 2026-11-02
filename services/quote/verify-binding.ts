import type { SupabaseClient } from "@supabase/supabase-js";
import { quoteHash, type QuoteResult, type QuoteSnapshot } from "@/domain/quote";
import { sha256Hex } from "@/lib/hash";
import { loadQuote, snapshotFromRow } from "./shared";

export type ApprovalBinding = { approvalId: string; quoteId: string; purchaseId: string | null; quoteHash: string; snapshot: QuoteSnapshot };

/**
 * For reservation, payments and fulfillment: is this approval still the customer's acceptance of exactly this quote?
 * Refuses unless the quote is ACCEPTED, its stored hash is the hash of its stored content, and the approval carries
 * that same hash. The returned snapshot is the only place an amount and currency may be read from.
 */
export async function verifyApprovalBinding(db: SupabaseClient, approvalId: string): Promise<QuoteResult<ApprovalBinding>> {
  const approval = await db.from("approvals").select("id, quote_version_id, quote_hash").eq("id", approvalId).maybeSingle();
  if (approval.error) throw new Error(`load approval: ${approval.error.message}`);
  if (!approval.data) return { ok: false, code: "NOT_FOUND" };

  const found = await loadQuote(db, approval.data.quote_version_id as string);
  if (!found) return { ok: false, code: "NOT_FOUND" };
  const { quote, merchantId } = found;

  if (quote.status === "SUPERSEDED" || quote.status === "EXPIRED" || quote.status === "WITHDRAWN") {
    return { ok: false, code: quote.status };
  }
  if (quote.status !== "ACCEPTED") return { ok: false, code: "QUOTE_TAMPERED" };

  const snapshot = snapshotFromRow(quote, merchantId);
  if (!snapshot || quote.quote_hash === null || quoteHash(snapshot, sha256Hex) !== quote.quote_hash) {
    return { ok: false, code: "QUOTE_TAMPERED" };
  }
  if (approval.data.quote_hash !== quote.quote_hash) return { ok: false, code: "HASH_MISMATCH" };

  const purchase = await db.from("purchases").select("id").eq("approval_id", approvalId).maybeSingle();
  if (purchase.error) throw new Error(`load purchase: ${purchase.error.message}`);

  return {
    ok: true,
    value: {
      approvalId,
      quoteId: quote.id,
      purchaseId: (purchase.data?.id as string | undefined) ?? null,
      quoteHash: quote.quote_hash,
      snapshot,
    },
  };
}
