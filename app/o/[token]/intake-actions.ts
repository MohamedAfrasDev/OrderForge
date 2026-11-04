"use server";

import { refresh } from "next/cache";
import { authorizeCustomerToken } from "@/lib/access/customer-session";
import type { VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { getIntakeModel } from "@/lib/ai/wiring";
import { newCorrelationId } from "@/lib/correlation";
import { createAdminClient } from "@/lib/supabase/admin";
import { FIELD_NAMES, parseAnswer, type FieldName, type IntakeErrorCode, type IntakeResult } from "@/domain/intake";
import { answerWithChoice, applyEdits, type AnswerOutcome } from "@/services/intake/answer";
import { chooseConfiguration, handOffToMerchant } from "@/services/intake/choose";
import { intakeFailureMessage } from "@/services/intake/customer-messages";
import { unansweredMessageId } from "@/services/intake/read";
import { loadInquiry } from "@/services/intake/shared";
import { postCustomerMessage } from "@/services/intake/start";
import { runIntakeTurn } from "@/services/intake/turn";

export type IntakeState = { status: "idle" } | { status: "error"; message: string } | { status: "done" };

const idle: IntakeState = { status: "idle" };
const failed = (code: IntakeErrorCode): IntakeState => ({ status: "error", message: intakeFailureMessage(code) });
const NOT_FOUND: IntakeState = failed("NOT_FOUND");
const ctx = () => ({ now: new Date().toISOString(), correlationId: newCorrelationId() });

/** The link is verified here, on the server, on every action; nothing from the browser says which inquiry this is. */
async function verified(token: string): Promise<VerifiedInquiryId | null> {
  const access = await authorizeCustomerToken(token);
  return access.ok ? access.inquiry.id : null;
}

/** One assistant turn for a stored message. A refusal because the message was already answered is not a problem. */
async function answer(inquiryId: VerifiedInquiryId, messageId: string): Promise<IntakeState> {
  try {
    const turn = await runIntakeTurn(createAdminClient(), { model: getIntakeModel() }, inquiryId, messageId, ctx());
    if (turn.ok || turn.code === "ALREADY_ANSWERED") return { status: "done" };
    return failed(turn.code);
  } catch {
    return failed("MODEL_UNAVAILABLE");
  }
}

/** What the customer is told after an answer was applied: done, or why the assistant could not carry on (their answer is kept). */
function stateOf(result: IntakeResult<AnswerOutcome>): IntakeState {
  if (!result.ok) return failed(result.code);
  if (result.value.turn === "FAILED") return failed(result.value.code ?? "MODEL_UNAVAILABLE");
  return { status: "done" };
}

/** The customer writes a message. It is stored first (so it survives any failure), then the assistant answers it once. */
export async function sendMessageAction(token: string, _previous: IntakeState, formData: FormData): Promise<IntakeState> {
  const inquiryId = await verified(token);
  if (!inquiryId) return NOT_FOUND;
  const db = createAdminClient();
  const posted = await postCustomerMessage(db, inquiryId, formData.get("message"), ctx());
  if (!posted.ok) {
    refresh();
    return failed(posted.code);
  }
  // With the shop, the message is for them: the assistant stays out of it.
  const inquiry = await loadInquiry(db, inquiryId);
  const result = inquiry?.status === "REVIEW_REQUIRED" ? ({ status: "done" } as IntakeState) : await answer(inquiryId, posted.value.messageId);
  refresh();
  return result;
}

/** "Try again": runs the newest unanswered message once more. */
export async function retryTurnAction(token: string): Promise<IntakeState> {
  const inquiryId = await verified(token);
  if (!inquiryId) return NOT_FOUND;
  const messageId = await unansweredMessageId(createAdminClient(), inquiryId);
  const result = messageId ? await answer(inquiryId, messageId) : idle;
  refresh();
  return result;
}

/** "Ask the shop to take over". */
export async function handOffAction(token: string): Promise<IntakeState> {
  const inquiryId = await verified(token);
  if (!inquiryId) return NOT_FOUND;
  const result = await handOffToMerchant(createAdminClient(), inquiryId, "customer_request", ctx());
  refresh();
  return result.ok ? { status: "done" } : failed(result.code);
}

/** "Choose this box": the form carries only which option, never an amount. */
export async function chooseAction(token: string, _previous: IntakeState, formData: FormData): Promise<IntakeState> {
  const inquiryId = await verified(token);
  if (!inquiryId) return NOT_FOUND;
  const result = await chooseConfiguration(createAdminClient(), {}, inquiryId, formData.get("key"), ctx());
  refresh();
  return result.ok ? { status: "done" } : failed(result.code);
}

/**
 * A line of "Your order so far" edited, or a typed answer to the open question: one field, one value read by `parseAnswer`
 * (blank clears the line), applied as the customer's own confirmed answer. The field is checked against the known lines.
 */
export async function editFieldAction(token: string, field: string, _previous: IntakeState, formData: FormData): Promise<IntakeState> {
  const inquiryId = await verified(token);
  if (!inquiryId) return NOT_FOUND;
  if (!(FIELD_NAMES as readonly string[]).includes(field)) return failed("INVALID_INPUT");
  const raw = formData.get("value");
  const parsed = parseAnswer(field as FieldName, typeof raw === "string" ? raw : "");
  if (!parsed.ok) return failed("INVALID_INPUT");
  const result = await runApply(inquiryId, { [field]: parsed.value });
  refresh();
  return result;
}

/**
 * A tap on a choice under the open question. The browser sends which field and which position; what the choice means is decided
 * on the server from the code's own list for the question that is open now.
 */
export async function quickReplyAction(token: string, field: string, index: number): Promise<IntakeState> {
  const inquiryId = await verified(token);
  if (!inquiryId) return NOT_FOUND;
  let result: IntakeState;
  try {
    result = stateOf(await answerWithChoice(createAdminClient(), { model: getIntakeModel() }, inquiryId, field, index, ctx()));
  } catch {
    result = failed("MODEL_UNAVAILABLE");
  }
  refresh();
  return result;
}

async function runApply(inquiryId: VerifiedInquiryId, edits: Record<string, unknown>): Promise<IntakeState> {
  try {
    return stateOf(await applyEdits(createAdminClient(), { model: getIntakeModel() }, inquiryId, edits, ctx()));
  } catch {
    return failed("MODEL_UNAVAILABLE");
  }
}
