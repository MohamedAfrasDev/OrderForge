import type { Condition, ConditionCode, QuoteSnapshot } from "@/domain/quote";
import type { ExceptionReason } from "./types";

/** What the local record says the payment must be. */
export type AttemptFacts = {
  amountMinor: number;
  currency: "USD";
  paypalOrderId: string | null;
  authorizationId: string | null;
};

export type Verification = { ok: true } | { ok: false; exception: ExceptionReason; reasons: ExceptionReason[] };

const verdict = (reasons: ExceptionReason[]): Verification => (reasons.length === 0 ? { ok: true } : { ok: false, exception: reasons[0]!, reasons });

/**
 * The only amount an order may be created for: the accepted snapshot's total. Never a browser value, never a model's.
 */
export function expectedPayment(snapshot: Pick<QuoteSnapshot, "totalMinor" | "currency">): { amountMinor: number; currency: "USD" } {
  if (!Number.isSafeInteger(snapshot.totalMinor) || snapshot.totalMinor <= 0) {
    throw new RangeError("expectedPayment: the quote total must be a positive integer");
  }
  return { amountMinor: snapshot.totalMinor, currency: snapshot.currency };
}

export type ProviderAuthorized = {
  orderId: string;
  authorizationId: string;
  authorizationStatus: string;
  amountMinor?: number;
  currency?: string;
};

/**
 * Does PayPal's authorize answer match the local record? Every problem is reported, in a fixed order (order, status,
 * currency, amount). A missing amount or currency is a problem too: verification needs positive evidence.
 */
export function verifyAuthorization(attempt: AttemptFacts, authorized: ProviderAuthorized): Verification {
  const reasons: ExceptionReason[] = [];
  if (attempt.paypalOrderId === null || authorized.orderId !== attempt.paypalOrderId) reasons.push("ORDER_MISMATCH");
  if (authorized.authorizationStatus !== "CREATED") reasons.push("STATUS_NOT_AS_EXPECTED");
  if (authorized.amountMinor === undefined || authorized.currency === undefined) reasons.push("EVIDENCE_MISSING");
  if (authorized.currency !== undefined && authorized.currency !== attempt.currency) reasons.push("CURRENCY_MISMATCH");
  if (authorized.amountMinor !== undefined && authorized.amountMinor !== attempt.amountMinor) reasons.push("AMOUNT_MISMATCH");
  return verdict(reasons);
}

export type ProviderOrder = { id: string; authorizationId?: string; captureId?: string };
export type ProviderCapture = { captureId: string; status: string; amountMinor?: number; currency?: string };

/**
 * Is this a real, completed capture of this attempt's money? The capture must be COMPLETED, for exactly the attempt's
 * amount and currency, and belong to the attempt's order and authorization. When a payee is configured it must have
 * been paid to that merchant. Anything else is a financial exception and the purchase is not paid.
 */
export function verifyCapture(
  attempt: AttemptFacts,
  order: ProviderOrder,
  capture: ProviderCapture,
  payee?: { expected?: string; actual?: string | null },
): Verification {
  const reasons: ExceptionReason[] = [];
  const add = (reason: ExceptionReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (attempt.paypalOrderId === null || order.id !== attempt.paypalOrderId || order.captureId !== capture.captureId) add("ORDER_MISMATCH");
  if (attempt.authorizationId === null || order.authorizationId === undefined || order.authorizationId !== attempt.authorizationId) add("AUTHORIZATION_MISMATCH");
  if (capture.status !== "COMPLETED") add("STATUS_NOT_AS_EXPECTED");
  if (capture.amountMinor === undefined || capture.currency === undefined) add("EVIDENCE_MISSING");
  if (capture.currency !== undefined && capture.currency !== attempt.currency) add("CURRENCY_MISMATCH");
  if (capture.amountMinor !== undefined && capture.amountMinor !== attempt.amountMinor) add("AMOUNT_MISMATCH");
  if (payee?.expected !== undefined) {
    if (payee.actual === undefined || payee.actual === null) add("EVIDENCE_MISSING");
    else if (payee.actual !== payee.expected) add("PAYEE_MISMATCH");
  }
  return verdict(reasons);
}

/** Conditions disclosed on the quote that are only pending, so the merchant must confirm each before accepting. */
const NEEDS_CONFIRMATION: ReadonlySet<ConditionCode> = new Set<ConditionCode>(["PRODUCTION_SLOT_CONFIRMATION", "ARTWORK_ACCEPTANCE"]);

/** What still blocks an accept: each pending condition on the quote that the merchant has not confirmed, once each, in the quote's order. */
export function unconfirmedConditions(conditions: readonly Condition[], confirmedCodes: readonly string[]): ConditionCode[] {
  const confirmed = new Set(confirmedCodes);
  const out: ConditionCode[] = [];
  for (const c of conditions) {
    if (NEEDS_CONFIRMATION.has(c.code) && !confirmed.has(c.code) && !out.includes(c.code)) out.push(c.code);
  }
  return out;
}
