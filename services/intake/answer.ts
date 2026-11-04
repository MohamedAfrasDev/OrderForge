import type { SupabaseClient } from "@supabase/supabase-js";
import { BLOCKING_FIELDS, quickRepliesFor, type IntakeErrorCode, type IntakeResult } from "@/domain/intake";
import type { VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { editRequirements } from "./edit";
import { latestRequirements, loadInquiry, type ServiceContext } from "./shared";
import { postCustomerMessage } from "./start";
import { runIntakeTurn, type TurnDeps } from "./turn";

export type AnswerOutcome = {
  /** The requirements version the customer's own answer was written as. */
  version: number;
  /** ANSWERED: the assistant carried on. SKIPPED: the request is with the shop, so only the answer was kept. FAILED: kept, but the assistant could not carry on. */
  turn: "ANSWERED" | "SKIPPED" | "FAILED";
  code?: IntakeErrorCode;
};

/**
 * The customer changes their order (a tapped choice, a typed answer, or a line edited in "Your order so far"). The answer is stored as
 * their own confirmed edit, under the same strict rules as any edit. Then it is announced with a numbered message (numbered so it is
 * never read as a double submit) and the assistant answers that message once, as for any message. A request that is with the shop
 * keeps the edit and leaves the assistant out. If the assistant fails, the edit is still kept and the failure is reported.
 */
export async function applyEdits(db: SupabaseClient, deps: TurnDeps, inquiryId: VerifiedInquiryId, edits: unknown, ctx: ServiceContext): Promise<IntakeResult<AnswerOutcome>> {
  const saved = await editRequirements(db, inquiryId, edits, ctx);
  if (!saved.ok) return saved;
  const version = saved.value.version;

  const inquiry = await loadInquiry(db, inquiryId);
  if (!inquiry) return { ok: false, code: "INQUIRY_NOT_FOUND" };
  if (inquiry.status === "REVIEW_REQUIRED") return { ok: true, value: { version, turn: "SKIPPED" } };

  const posted = await postCustomerMessage(db, inquiryId, `I updated my requirements (change ${version}).`, ctx);
  if (!posted.ok) return { ok: true, value: { version, turn: "FAILED", code: posted.code } };

  const turn = await runIntakeTurn(db, deps, inquiryId, posted.value.messageId, ctx);
  if (turn.ok || turn.code === "ALREADY_ANSWERED") return { ok: true, value: { version, turn: "ANSWERED" } };
  return { ok: true, value: { version, turn: "FAILED", code: turn.code } };
}

/**
 * A tap on one of the choices shown under the open question. The browser says which field and which choice (by position); what that
 * choice means is decided here, from the code's own list for the question that is open right now, never from anything the browser
 * sends. A field that is not the open question, a position that is not offered, or no open question at all is refused (a stale button).
 */
export async function answerWithChoice(db: SupabaseClient, deps: TurnDeps, inquiryId: VerifiedInquiryId, field: unknown, index: unknown, ctx: ServiceContext): Promise<IntakeResult<AnswerOutcome>> {
  if (typeof field !== "string" || !(BLOCKING_FIELDS as readonly string[]).includes(field)) return { ok: false, code: "INVALID_INPUT" };
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return { ok: false, code: "INVALID_INPUT" };

  const latest = await latestRequirements(db, inquiryId);
  if (!latest || latest.stored.question?.field !== field) return { ok: false, code: "INVALID_INPUT", cause: "that question is not open" };
  const choice = quickRepliesFor({ field: field as (typeof BLOCKING_FIELDS)[number] }, latest.stored.fields).choices[index];
  if (!choice) return { ok: false, code: "INVALID_INPUT", cause: "no such choice" };
  return applyEdits(db, deps, inquiryId, choice.edit, ctx);
}
