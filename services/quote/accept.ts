import type { SupabaseClient } from "@supabase/supabase-js";
import { validateConfiguration, type Configuration } from "@/domain/catalog";
import { isExpired, quoteHash, renderTerms, type QuoteErrorCode, type QuoteResult, type QuoteSnapshot } from "@/domain/quote";
import { audit } from "@/lib/audit";
import { sha256Hex } from "@/lib/hash";
import type { VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { auditInsertFor, loadQuote, loadValidityHours, snapshotFromRow, type QuoteRow, type ServiceContext } from "./shared";

export type Accepted = { approvalId: string; purchaseId: string };

/**
 * The customer accepts the exact quote version they were shown. Only a verified inquiry id can be passed in, and the
 * quote must belong to it. The server recomputes the hash from the stored row, compares it with the stored one and with
 * the customer's, and re-checks the offer against the current catalog and stock. Approval and purchase are then
 * created together by one database transaction, which is idempotent for the same quote and hash.
 */
export async function acceptQuote(
  db: SupabaseClient,
  inquiryId: VerifiedInquiryId,
  quoteId: string,
  expectedHash: string,
  ctx: ServiceContext,
): Promise<QuoteResult<Accepted>> {
  const found = await loadQuote(db, quoteId);
  // Another customer's quote looks exactly like a missing one.
  if (!found || found.quote.inquiry_id !== inquiryId) return { ok: false, code: "NOT_FOUND" };
  const { quote, merchantId } = found;
  const validityHours = await loadValidityHours(db, merchantId);

  if (quote.status === "PUBLISHED" && !isExpired(quote.published_at!, validityHours, ctx.now)) {
    const refusal = await checkOffer(db, quote, merchantId, expectedHash);
    if (refusal) return refusal;
  }

  const snapshot = quote.status === "PUBLISHED" ? snapshotFromRow(quote, merchantId) : null;
  const rpc = await db.rpc("accept_quote", {
    p_quote_id: quoteId,
    p_expected_hash: expectedHash,
    p_terms_text: snapshot ? renderTerms(snapshot) : "",
    p_now: ctx.now,
    p_validity_hours: validityHours,
  });
  if (rpc.error) throw new Error(`accept_quote: ${rpc.error.message}`);
  const result = rpc.data as { ok: boolean; code?: QuoteErrorCode; already?: boolean; approval_id?: string; purchase_id?: string };

  const insertAudit = auditInsertFor(db);
  const who = `customer:${inquiryId}`;
  if (!result.ok) {
    if (result.code === "EXPIRED") {
      await audit(insertAudit, {
        actor: "system",
        action: "quote.expired",
        entity: "quote_version",
        entityId: quoteId,
        correlationId: ctx.correlationId,
        data: { quote_version: quote.version, inquiry_id: inquiryId, from: "PUBLISHED", to: "EXPIRED" },
      });
    }
    return { ok: false, code: result.code! };
  }

  if (!result.already) {
    await audit(insertAudit, {
      actor: who,
      action: "quote.accepted",
      entity: "quote_version",
      entityId: quoteId,
      correlationId: ctx.correlationId,
      data: {
        quote_version: quote.version,
        inquiry_id: inquiryId,
        quote_hash: expectedHash,
        purchase_id: result.purchase_id,
        from: "PUBLISHED",
        to: "ACCEPTED",
      },
    });
  }
  return { ok: true, value: { approvalId: result.approval_id!, purchaseId: result.purchase_id! } };
}

/** Everything that must still be true of a published quote before it can be accepted. Null means it is fine. */
async function checkOffer(
  db: SupabaseClient,
  quote: QuoteRow,
  merchantId: string,
  expectedHash: string,
): Promise<QuoteResult<never> | null> {
  const snapshot = snapshotFromRow(quote, merchantId);
  if (!snapshot || quote.quote_hash === null || quoteHash(snapshot, sha256Hex) !== quote.quote_hash) {
    return { ok: false, code: "QUOTE_TAMPERED" };
  }
  if (expectedHash !== quote.quote_hash) return { ok: false, code: "HASH_MISMATCH" };

  // The static constraints (no food, logo, budget, date) were validated when the draft was made. What can drift
  // afterwards is price, stock, activity and naming, so those are re-checked against the current catalog.
  const { catalog, stock } = await loadCatalogSnapshot(db, merchantId);
  const configuration: Configuration = {
    boxCount: snapshot.boxCount,
    selections: Object.fromEntries(snapshot.lines.map((l) => [l.slotId, l.sku])),
  };
  const current = validateConfiguration({
    configuration,
    catalog,
    requirements: { noFood: false, logoRequired: false },
    stock,
    today: "1970-01-01",
  });
  if (!current.ok) return { ok: false, code: "CONFIGURATION_BLOCKED", blockers: current.blockers };

  const same =
    current.priced.totalMinor === snapshot.totalMinor &&
    current.priced.perBoxMinor === snapshot.perBoxMinor &&
    sameLines(current.priced.lines, snapshot.lines);
  return same ? null : { ok: false, code: "QUOTE_STALE" };
}

function sameLines(a: QuoteSnapshot["lines"], b: QuoteSnapshot["lines"]): boolean {
  return (
    a.length === b.length &&
    a.every((l, i) => {
      const o = b[i]!;
      return l.slotId === o.slotId && l.sku === o.sku && l.name === o.name && l.unitPriceMinor === o.unitPriceMinor && l.quantity === o.quantity;
    })
  );
}
