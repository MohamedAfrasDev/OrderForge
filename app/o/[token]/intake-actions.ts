"use server";

import { refresh } from "next/cache";
import { authorizeCustomerToken } from "@/lib/access/customer-session";
import type { VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { getIntakeModel } from "@/lib/ai/wiring";
import { newCorrelationId } from "@/lib/correlation";
import { createAdminClient } from "@/lib/supabase/admin";
import type { IntakeErrorCode } from "@/domain/intake";
import { chooseConfiguration, handOffToMerchant } from "@/services/intake/choose";
import { intakeFailureMessage } from "@/services/intake/customer-messages";
import { editRequirements } from "@/services/intake/edit";
import { requirementsForCustomer, unansweredMessageId } from "@/services/intake/read";
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
  // With the merchant, the message is for them: the assistant stays out of it.
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

/** "Ask the merchant to take over". */
export async function handOffAction(token: string): Promise<IntakeState> {
  const inquiryId = await verified(token);
  if (!inquiryId) return NOT_FOUND;
  const result = await handOffToMerchant(createAdminClient(), inquiryId, "customer_request", ctx());
  refresh();
  return result.ok ? { status: "done" } : failed(result.code);
}

/** "Use this one": the form carries only which option, never an amount. */
export async function chooseAction(token: string, _previous: IntakeState, formData: FormData): Promise<IntakeState> {
  const inquiryId = await verified(token);
  if (!inquiryId) return NOT_FOUND;
  const result = await chooseConfiguration(createAdminClient(), {}, inquiryId, formData.get("key"), ctx());
  refresh();
  return result.ok ? { status: "done" } : failed(result.code);
}

const text = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim() : "");
const yesNo = (v: string): boolean | null | "bad" => (v === "" ? null : v === "yes" ? true : v === "no" ? false : "bad");

/**
 * The customer edits the visible specification. Only fields that differ from what is recorded are sent, as the customer's own
 * confirmed values (blank clears one). Then a short message asks the assistant to look again, so a fresh proposal appears.
 */
export async function editSpecAction(token: string, _previous: IntakeState, formData: FormData): Promise<IntakeState> {
  const inquiryId = await verified(token);
  if (!inquiryId) return NOT_FOUND;
  const db = createAdminClient();
  const current = await requirementsForCustomer(db, inquiryId);
  const before = (name: string) => current?.fields.find((f) => f.name === name)?.value ?? null;

  const wanted: Record<string, unknown> = {};
  const boxes = text(formData.get("boxCount"));
  wanted.boxCount = boxes === "" ? null : /^\d{1,7}$/.test(boxes) ? Number(boxes) : "bad";
  wanted.noFood = yesNo(text(formData.get("noFood")));
  wanted.logoRequired = yesNo(text(formData.get("logoRequired")));
  const budget = text(formData.get("budget"));
  wanted.maxPricePerBoxMinor = budget === "" ? null : /^\d{1,6}(\.\d{1,2})?$/.test(budget) ? Math.round(Number(budget) * 100) : "bad";
  const date = text(formData.get("requestedPickupDate"));
  wanted.requestedPickupDate = date === "" ? null : date;
  const prefs = text(formData.get("preferences"));
  wanted.preferences = prefs === "" ? null : prefs.split(",").map((p) => p.trim()).filter(Boolean);

  const edits: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(wanted)) {
    if (value === "bad") return failed("INVALID_INPUT");
    if (JSON.stringify(value) !== JSON.stringify(before(name))) edits[name] = value;
  }
  if (Object.keys(edits).length === 0) return { status: "error", message: "Nothing changed." };

  const saved = await editRequirements(db, inquiryId, edits, ctx());
  if (!saved.ok) return failed(saved.code);
  const inquiry = await loadInquiry(db, inquiryId);
  if (inquiry?.status === "REVIEW_REQUIRED") {
    refresh();
    return { status: "done" };
  }
  // A new proposal is made from a message, so the edit is announced as one (numbered, so it is never read as a double submit).
  const posted = await postCustomerMessage(db, inquiryId, `I updated my requirements (change ${saved.value.version}).`, ctx());
  const result = posted.ok ? await answer(inquiryId, posted.value.messageId) : failed(posted.code);
  refresh();
  return result;
}
