import type { SupabaseClient } from "@supabase/supabase-js";
import { validateConfiguration, type PricedConfiguration } from "@/domain/catalog";
import { draftInputSchema, gateForPublish, type QuoteResult } from "@/domain/quote";
import { audit } from "@/lib/audit";
import { loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { auditInsertFor, loadQuote, setInquiryStatus, type ServiceContext } from "./shared";

export type DraftCreated = { quoteId: string; version: number; held: boolean; priced: PricedConfiguration };

/**
 * Prices a configuration into a DRAFT quote version. The input is untrusted (it may come from a model): it is parsed
 * with a strict schema, so there is nowhere to put an amount, and the configuration must pass validateConfiguration
 * against the merchant's current catalog and stock. A draft that carries an unresolved mandatory condition is held
 * and its inquiry goes to REVIEW_REQUIRED.
 */
export async function createQuoteDraft(db: SupabaseClient, input: unknown, ctx: ServiceContext): Promise<QuoteResult<DraftCreated>> {
  const parsed = draftInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  const draft = parsed.data;

  const inquiry = await db.from("inquiries").select("id, merchant_id").eq("id", draft.inquiryId).maybeSingle();
  if (inquiry.error) throw new Error(`load inquiry: ${inquiry.error.message}`);
  if (!inquiry.data) return { ok: false, code: "NOT_FOUND" };
  const merchantId = inquiry.data.merchant_id as string;

  if (draft.requirementVersionId !== null) {
    const rv = await db
      .from("requirement_versions")
      .select("id")
      .eq("id", draft.requirementVersionId)
      .eq("inquiry_id", draft.inquiryId)
      .maybeSingle();
    if (rv.error) throw new Error(`load requirement version: ${rv.error.message}`);
    if (!rv.data) return { ok: false, code: "INVALID_INPUT" };
  }

  const { catalog, stock } = await loadCatalogSnapshot(db, merchantId);
  const validation = validateConfiguration({
    configuration: draft.configuration,
    catalog,
    requirements: draft.requirements,
    stock,
    today: ctx.now.slice(0, 10),
  });
  if (!validation.ok) return { ok: false, code: "CONFIGURATION_BLOCKED", blockers: validation.blockers };
  const { priced } = validation;

  const created = await db.rpc("create_quote_draft", {
    p_inquiry_id: draft.inquiryId,
    p_requirement_version_id: draft.requirementVersionId,
    p_lines: { boxCount: priced.boxCount, perBoxMinor: priced.perBoxMinor, lines: priced.lines },
    p_total_minor: priced.totalMinor,
    p_pending_conditions: draft.conditions,
  });
  if (created.error) throw new Error(`create_quote_draft: ${created.error.message}`);
  const result = created.data as { ok: boolean; code?: string; quote_id?: string; version?: number };
  if (!result.ok) return { ok: false, code: "NOT_FOUND" };

  const insertAudit = auditInsertFor(db);
  await audit(insertAudit, {
    actor: "system",
    action: "quote.draft_created",
    entity: "quote_version",
    entityId: result.quote_id!,
    correlationId: ctx.correlationId,
    data: { quote_version: result.version, inquiry_id: draft.inquiryId, status: "DRAFT" },
  });

  const held = !gateForPublish(draft.conditions).canAutoPublish;
  if (held) await setInquiryStatus(db, draft.inquiryId, "REVIEW_REQUIRED");

  return { ok: true, value: { quoteId: result.quote_id!, version: result.version!, held, priced } };
}

/** The intake tool `request_merchant_review`: the draft waits for a person, and the inquiry says so. */
export async function requestMerchantReview(db: SupabaseClient, quoteId: string, ctx: ServiceContext): Promise<QuoteResult<void>> {
  const found = await loadQuote(db, quoteId);
  if (!found) return { ok: false, code: "NOT_FOUND" };
  if (found.quote.status !== "DRAFT") return { ok: false, code: "NOT_DRAFT" };

  await setInquiryStatus(db, found.quote.inquiry_id, "REVIEW_REQUIRED");
  await audit(auditInsertFor(db), {
    actor: "system",
    action: "quote.review_requested",
    entity: "quote_version",
    entityId: quoteId,
    correlationId: ctx.correlationId,
    data: { quote_version: found.quote.version, inquiry_id: found.quote.inquiry_id, status: "REVIEW_REQUIRED" },
  });
  return { ok: true, value: undefined };
}
