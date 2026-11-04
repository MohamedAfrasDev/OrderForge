import type { SupabaseClient } from "@supabase/supabase-js";
import { validateConfiguration } from "@/domain/catalog";
import { blockingFields, confirmedBoxCount, toCatalogRequirements, type IntakeResult, type Proposal, type RequirementsDoc, type StoredRequirements } from "@/domain/intake";
import type { Condition } from "@/domain/quote";
import type { VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { cents, format } from "@/lib/money";
import { loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { createQuoteDraft, requestMerchantReview } from "@/services/quote/create-draft";
import { publishQuote } from "@/services/quote/publish";
import { appendMessage, appendRequirements, auditIntake, latestRequirements, loadInquiry, transitionInquiry, type ServiceContext } from "./shared";

const ACTOR = "system:intake";
const KEY = /^(proposal|alt-\d{1,2})$/;

export type ChooseDeps = {
  /** Conditions a quote for these requirements carries. Defaults to none: nothing in a typed request is unsupported by code. */
  conditionsFor?: (fields: RequirementsDoc) => Condition[];
};

export type Chosen = { quoteId: string; status: "QUOTE_READY" | "REVIEW_REQUIRED"; boxCount: number; perBoxMinor: number; totalMinor: number };

/** The newest version is no longer the one the proposal was shown on, or it was already claimed. */
class ClaimLost extends Error {
  constructor(readonly alreadyChosen: boolean) {
    super("claim lost");
  }
}

const REVIEW_NOTE = "This request needs the shop to look at it before a quote can be offered. They will reply here.";

/**
 * The customer picks one proposed box by its key (never an amount). Code revalidates it against live stock and prices (a box
 * that no longer holds, or whose price moved, is `PROPOSAL_STALE`), claims the proposal by writing the next requirements
 * version with the key on it (the unique version number lets only one of two clicks win), then asks the quote module for a
 * draft, which validates once more. A quote with nothing mandatory unresolved is published (`QUOTE_READY`); otherwise the draft
 * goes to the merchant (`REVIEW_REQUIRED`). The total is the catalog engine's, nothing else.
 */
export async function chooseConfiguration(db: SupabaseClient, deps: ChooseDeps, inquiryId: VerifiedInquiryId, proposalKey: unknown, ctx: ServiceContext): Promise<IntakeResult<Chosen>> {
  if (typeof proposalKey !== "string" || !KEY.test(proposalKey)) return { ok: false, code: "INVALID_INPUT" };
  const inquiry = await loadInquiry(db, inquiryId);
  if (!inquiry) return { ok: false, code: "INQUIRY_NOT_FOUND" };
  if (inquiry.status !== "CONFIGURING") return { ok: false, code: "ILLEGAL_TRANSITION", cause: `the inquiry is ${inquiry.status}` };

  const latest = await latestRequirements(db, inquiryId);
  const proposal = latest?.stored.proposal;
  if (!latest || !proposal) return { ok: false, code: "PROPOSAL_STALE", cause: "there is no proposal to choose from" };
  if (proposal.chosen) return { ok: false, code: "ILLEGAL_TRANSITION", cause: "already chosen" };

  const picked = pick(proposal, proposalKey);
  if (!picked) return { ok: false, code: "INVALID_INPUT", cause: "no such option" };
  const fields = latest.stored.fields;
  const boxCount = confirmedBoxCount(fields);
  if (boxCount === null || blockingFields(fields).length > 0) return { ok: false, code: "PROPOSAL_STALE", cause: "the requirements changed" };

  const snapshot = await loadCatalogSnapshot(db, inquiry.merchantId);
  const requirements = toCatalogRequirements(fields);
  const live = validateConfiguration({ configuration: { boxCount, selections: picked.selections }, catalog: snapshot.catalog, requirements, stock: snapshot.stock, today: ctx.now.slice(0, 10) });
  if (!live.ok) return { ok: false, code: "PROPOSAL_STALE", cause: [...new Set(live.blockers.map((b) => b.code))].join(", ") };
  if (live.priced.totalMinor !== picked.totalMinor || live.priced.perBoxMinor !== picked.perBoxMinor) return { ok: false, code: "PROPOSAL_STALE", cause: "the price changed" };

  let claim: { id: string };
  try {
    claim = await appendRequirements(
      db,
      inquiryId,
      (now): StoredRequirements => {
        if (!now || now.id !== latest.id) throw new ClaimLost(now?.stored.proposal?.chosen != null);
        return { ...now.stored, proposal: { ...proposal, chosen: proposalKey } };
      },
      null,
    );
  } catch (error) {
    if (error instanceof ClaimLost) {
      return error.alreadyChosen ? { ok: false, code: "ILLEGAL_TRANSITION", cause: "already chosen" } : { ok: false, code: "PROPOSAL_STALE", cause: "the requirements changed" };
    }
    throw error;
  }

  const draft = await createQuoteDraft(
    db,
    { inquiryId, configuration: { boxCount, selections: picked.selections }, requirements, requirementVersionId: claim.id, conditions: deps.conditionsFor?.(fields) ?? [] },
    ctx,
  );
  if (!draft.ok) {
    await release(db, inquiryId);
    if (draft.code === "CONFIGURATION_BLOCKED") return { ok: false, code: "PROPOSAL_STALE", cause: [...new Set((draft.blockers ?? []).map((b) => b.code))].join(", ") };
    return { ok: false, code: draft.code === "NOT_FOUND" ? "NOT_FOUND" : "INVALID_INPUT" };
  }
  const { quoteId, held, priced } = draft.value;
  const base = { quoteId, boxCount: priced.boxCount, perBoxMinor: priced.perBoxMinor, totalMinor: priced.totalMinor };
  await auditIntake(db, ctx, `customer:${inquiryId}`, "intake.configuration_chosen", inquiryId, { quote_version: draft.value.version });

  if (!held) {
    const published = await publishQuote(db, quoteId, { kind: "system" }, ctx);
    if (published.ok) {
      await auditIntake(db, ctx, ACTOR, "intake.state_changed", inquiryId, { from: "CONFIGURING", to: "QUOTE_READY" });
      await note(db, inquiryId, "assistant", `Your quote is ready: ${format(cents(priced.totalMinor))} for ${priced.boxCount} boxes (${format(cents(priced.perBoxMinor))} per box). Review it and accept it when you are ready.`, ctx);
      return { ok: true, value: { ...base, status: "QUOTE_READY" } };
    }
    if (published.code !== "MERCHANT_REVIEW_REQUIRED") throw new Error(`publish quote: ${published.code}`);
  }

  const review = await requestMerchantReview(db, quoteId, ctx);
  if (!review.ok) throw new Error(`request review: ${review.code}`);
  await auditIntake(db, ctx, ACTOR, "intake.state_changed", inquiryId, { from: "CONFIGURING", to: "REVIEW_REQUIRED" });
  await note(db, inquiryId, "system", REVIEW_NOTE, ctx);
  return { ok: true, value: { ...base, status: "REVIEW_REQUIRED" } };
}

function pick(proposal: Proposal, key: string): { selections: Record<string, string>; perBoxMinor: number; totalMinor: number } | null {
  if (key === "proposal") {
    if (proposal.status !== "VALID" || !proposal.priced) return null;
    return { selections: proposal.selections, perBoxMinor: proposal.priced.perBoxMinor, totalMinor: proposal.priced.totalMinor };
  }
  const alt = proposal.alternatives.find((a) => a.key === key);
  if (!alt) return null;
  return { selections: { ...proposal.selections, [alt.slotId]: alt.toSku }, perBoxMinor: alt.perBoxMinor, totalMinor: alt.totalMinor };
}

/** The draft could not be made after the claim: take the claim back so the customer can choose again after a fresh proposal. */
async function release(db: SupabaseClient, inquiryId: string): Promise<void> {
  await appendRequirements(db, inquiryId, (now) => ({ ...(now as NonNullable<typeof now>).stored, proposal: null }), null);
}

const note = appendMessage;

export type HandOffReason = "customer_request" | "failure";

const HANDOFF_NOTE: Record<HandOffReason, string> = {
  customer_request: "You asked the shop to take over. They can see this conversation and your requirements, and they will reply here.",
  failure: "The assistant could not continue, so the shop will take over. They can see this conversation and your requirements.",
};

/**
 * Sends the inquiry to the merchant (demo step H, and the customer's own request). Any state before a quote is ready moves to
 * `REVIEW_REQUIRED` with one note; repeating it is a no-op that adds nothing. With a quote ready, the customer keeps the quote.
 */
export async function handOffToMerchant(db: SupabaseClient, inquiryId: VerifiedInquiryId, reason: HandOffReason, ctx: ServiceContext): Promise<IntakeResult<{ changed: boolean }>> {
  if (reason !== "customer_request" && reason !== "failure") return { ok: false, code: "INVALID_INPUT" };
  const inquiry = await loadInquiry(db, inquiryId);
  if (!inquiry) return { ok: false, code: "INQUIRY_NOT_FOUND" };
  if (inquiry.status === "REVIEW_REQUIRED") return { ok: true, value: { changed: false } };

  const moved = await transitionInquiry(db, inquiryId, { type: "HAND_OFF" }, ctx, reason === "customer_request" ? `customer:${inquiryId}` : ACTOR);
  // Another request got there first: the inquiry is with the merchant already, which is what was asked for.
  if (!moved.ok && moved.code === "ILLEGAL_TRANSITION" && moved.status === "REVIEW_REQUIRED") return { ok: true, value: { changed: false } };
  if (!moved.ok) return { ok: false, code: moved.code, cause: `the inquiry is ${moved.status ?? inquiry.status}` };
  if (!moved.changed) return { ok: true, value: { changed: false } };

  await auditIntake(db, ctx, ctx.actor ?? ACTOR, "intake.handed_off", inquiryId, { reason });
  await note(db, inquiryId, "system", HANDOFF_NOTE[reason], ctx);
  return { ok: true, value: { changed: true } };
}
