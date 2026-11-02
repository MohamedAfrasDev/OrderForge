import type { SupabaseClient } from "@supabase/supabase-js";
import {
  conditionSchema,
  gateForPublish,
  quoteHash,
  transition,
  type Condition,
  type QuoteErrorCode,
  type QuoteResult,
} from "@/domain/quote";
import { audit } from "@/lib/audit";
import { sha256Hex } from "@/lib/hash";
import {
  actorName,
  auditInsertFor,
  loadQuote,
  parseConditions,
  setInquiryStatus,
  snapshotFromRow,
  type Actor,
  type MerchantActor,
  type ServiceContext,
} from "./shared";

export type PublishContext = ServiceContext & {
  /** The merchant's own wording when they approve an unsupported customization. */
  approvalText?: string;
};

export type Published = { quoteId: string; hash: string; supersededQuoteId: string | null; invalidatedPurchaseIds: string[] };

/**
 * Publishes a DRAFT. The system may do it only when nothing mandatory is unresolved; otherwise the quote stays a draft
 * and the inquiry goes to REVIEW_REQUIRED. A merchant (who must own the inquiry) may publish a held draft by giving
 * their own wording, which replaces the unresolved item as a disclosed MERCHANT_APPROVED_CUSTOMIZATION. The hash is
 * computed here from the stored row and then stored with the status change in one database transaction.
 */
export async function publishQuote(
  db: SupabaseClient,
  quoteId: string,
  actor: Actor,
  ctx: PublishContext,
): Promise<QuoteResult<Published>> {
  const found = await loadQuote(db, quoteId);
  if (!found) return { ok: false, code: "NOT_FOUND" };
  if (actor.kind === "merchant" && actor.merchantId !== found.merchantId) return { ok: false, code: "NOT_FOUND" };
  const { quote, merchantId } = found;
  if (quote.status !== "DRAFT") return { ok: false, code: "NOT_DRAFT" };

  const conditions = parseConditions(quote.pending_conditions);
  if (!conditions) throw new Error(`quote ${quoteId} has malformed pending_conditions`);

  const gate = gateForPublish(conditions);
  let approved: Condition | null = null;
  if (!gate.canAutoPublish) {
    if (actor.kind === "system") {
      await setInquiryStatus(db, quote.inquiry_id, "REVIEW_REQUIRED");
      return { ok: false, code: "MERCHANT_REVIEW_REQUIRED" };
    }
    const wording = conditionSchema.safeParse({ code: "MERCHANT_APPROVED_CUSTOMIZATION", text: ctx.approvalText ?? "" });
    if (!wording.success) return { ok: false, code: "INVALID_INPUT" };
    approved = wording.data;
    const resolved = [...conditions.filter((c) => c.code !== "UNSUPPORTED_CUSTOMIZATION"), approved];
    const updated = await db.from("quote_versions").update({ pending_conditions: resolved }).eq("id", quoteId).eq("status", "DRAFT");
    if (updated.error) throw new Error(`update conditions: ${updated.error.message}`);
    quote.pending_conditions = resolved;
  }

  const snapshot = snapshotFromRow(quote, merchantId);
  if (!snapshot) throw new Error(`quote ${quoteId} does not fit the stored shape`);
  const hash = quoteHash(snapshot, sha256Hex);

  const rpc = await db.rpc("publish_quote", { p_quote_id: quoteId, p_hash: hash, p_now: ctx.now });
  if (rpc.error) throw new Error(`publish_quote: ${rpc.error.message}`);
  const result = rpc.data as {
    ok: boolean;
    code?: QuoteErrorCode;
    superseded_quote_id?: string | null;
    invalidated_purchase_ids?: string[];
  };
  if (!result.ok) return { ok: false, code: result.code! };

  const insertAudit = auditInsertFor(db);
  const who = actorName(actor);
  if (approved) {
    await audit(insertAudit, {
      actor: who,
      action: "quote.customization_approved",
      entity: "quote_version",
      entityId: quoteId,
      correlationId: ctx.correlationId,
      data: { quote_version: quote.version, inquiry_id: quote.inquiry_id, reason: approved.text },
    });
  }
  await audit(insertAudit, {
    actor: who,
    action: "quote.published",
    entity: "quote_version",
    entityId: quoteId,
    correlationId: ctx.correlationId,
    data: { quote_version: quote.version, inquiry_id: quote.inquiry_id, quote_hash: hash, from: "DRAFT", to: "PUBLISHED" },
  });
  const supersededQuoteId = result.superseded_quote_id ?? null;
  if (supersededQuoteId) {
    await audit(insertAudit, {
      actor: who,
      action: "quote.superseded",
      entity: "quote_version",
      entityId: supersededQuoteId,
      correlationId: ctx.correlationId,
      data: { inquiry_id: quote.inquiry_id, to: "SUPERSEDED", reason: `replaced by version ${quote.version}` },
    });
  }

  return {
    ok: true,
    value: { quoteId, hash, supersededQuoteId, invalidatedPurchaseIds: result.invalidated_purchase_ids ?? [] },
  };
}

/** A merchant withdraws a draft or a published quote. An accepted quote cannot be withdrawn here. */
export async function withdrawQuote(
  db: SupabaseClient,
  quoteId: string,
  actor: MerchantActor,
  reason: string,
  ctx: ServiceContext,
): Promise<QuoteResult<void>> {
  const found = await loadQuote(db, quoteId);
  if (!found || found.merchantId !== actor.merchantId) return { ok: false, code: "NOT_FOUND" };
  const why = reason.trim();
  if (why.length < 1 || why.length > 500) return { ok: false, code: "INVALID_INPUT" };

  const { quote } = found;
  const next = transition(quote.status, "WITHDRAW");
  if (typeof next !== "string") return { ok: false, code: "ILLEGAL_TRANSITION" };

  // Guarded on the status we read: if an accept or a publish got in first, nothing is updated.
  const updated = await db.from("quote_versions").update({ status: next }).eq("id", quoteId).eq("status", quote.status).select("id");
  if (updated.error) throw new Error(`withdraw quote: ${updated.error.message}`);
  if ((updated.data ?? []).length === 0) return { ok: false, code: "ILLEGAL_TRANSITION" };

  const live = await db
    .from("quote_versions")
    .select("id")
    .eq("inquiry_id", quote.inquiry_id)
    .in("status", ["PUBLISHED", "ACCEPTED"])
    .limit(1);
  if (live.error) throw new Error(`check live quote: ${live.error.message}`);
  await setInquiryStatus(db, quote.inquiry_id, (live.data ?? []).length === 0 ? "CONFIGURING" : "QUOTE_READY");

  await audit(auditInsertFor(db), {
    actor: actorName(actor),
    action: "quote.withdrawn",
    entity: "quote_version",
    entityId: quoteId,
    correlationId: ctx.correlationId,
    data: { quote_version: quote.version, inquiry_id: quote.inquiry_id, from: quote.status, to: next, reason: why },
  });
  return { ok: true, value: undefined };
}
