import type { PaymentErrorCode } from "@/domain/payments";
import type { CustomerPaymentView } from "./read";

/** The only values the order room accepts in `?payment=`: anything else is ignored. */
export const PAYMENT_NOTICES = [
  "DONE",
  "NOT_APPROVED",
  "PROVIDER_REFUSED",
  "PROVIDER_UNREACHABLE",
  "OUTCOME_UNKNOWN",
  "FINANCIAL_EXCEPTION",
  "RESERVATION_REFUSED",
  "QUOTE_NOT_ACCEPTED",
  "ATTEMPT_ACTIVE",
  "UNAVAILABLE",
] as const;
export type PaymentNotice = (typeof PAYMENT_NOTICES)[number];

export function paymentNoticeOf(value: string | string[] | undefined): PaymentNotice | null {
  return typeof value === "string" && (PAYMENT_NOTICES as readonly string[]).includes(value) ? (value as PaymentNotice) : null;
}

/** A result code as a notice. Codes with no special wording share the general one. */
export function noticeForCode(code: PaymentErrorCode): PaymentNotice {
  switch (code) {
    case "NOT_APPROVED":
    case "PROVIDER_REFUSED":
    case "PROVIDER_UNREACHABLE":
    case "OUTCOME_UNKNOWN":
    case "FINANCIAL_EXCEPTION":
    case "RESERVATION_REFUSED":
    case "QUOTE_NOT_ACCEPTED":
    case "ATTEMPT_ACTIVE":
      return code;
    default:
      return "UNAVAILABLE";
  }
}

/** Plain words only: no codes, ids or amounts. */
export function noticeMessage(notice: PaymentNotice): string {
  switch (notice) {
    case "DONE":
      return "Thank you. Your payment is authorized with PayPal and is waiting for the merchant to confirm your order.";
    case "NOT_APPROVED":
      return "PayPal does not show your payment as approved yet. If you just finished approving it, wait a moment and reload this page; otherwise pay again.";
    case "PROVIDER_REFUSED":
      return "PayPal could not complete this payment. Nothing was taken. You can try again.";
    case "PROVIDER_UNREACHABLE":
      return "PayPal could not be reached. Nothing was taken. Try again in a moment.";
    case "OUTCOME_UNKNOWN":
      return "We are checking with PayPal what happened to your payment. Please do not pay again; this page will update.";
    case "FINANCIAL_EXCEPTION":
      return "We found something to check on your payment, and it has been passed to the merchant. Please do not pay again.";
    case "RESERVATION_REFUSED":
      return "Your items could not be held for you right now. Ask the merchant to hold them again.";
    case "QUOTE_NOT_ACCEPTED":
      return "This quote is no longer accepted, so it cannot be paid. Ask the merchant for a current one.";
    case "ATTEMPT_ACTIVE":
      return "A payment for this order is already in progress.";
    default:
      return "That could not be done right now. Reload the page and try again.";
  }
}

export function statusMessage(status: CustomerPaymentView["status"]): string | null {
  switch (status) {
    case "PAYING":
      return "Your payment has been started. Finish it with PayPal to complete your order.";
    case "WAITING_MERCHANT":
      return "Your payment is authorized with PayPal. The merchant will confirm your order; you are charged only when they do.";
    case "CHECKING":
      return "We are checking your payment with PayPal. This page will update. Please do not pay again.";
    case "PAID":
      return "Paid. Thank you: your order is confirmed.";
    case "DECLINED":
      return "The merchant could not take this order. Your PayPal authorization was cancelled and you were not charged.";
    case "FAILED":
      return "The payment could not be completed. Nothing was taken. You can try again.";
    default:
      return null;
  }
}

/** What the merchant is told when deciding fails. */
export function decisionFailureMessage(code: PaymentErrorCode, cause?: string): string {
  switch (code) {
    case "CONDITIONS_UNCONFIRMED":
      return "Confirm every condition listed on this order before accepting it.";
    case "REASON_REQUIRED":
      return "Write a reason for declining (up to 500 characters).";
    case "DECISION_ALREADY_MADE":
      return "A decision was already made on this order. Reload the page.";
    case "CAPTURE_BLOCKED":
      return cause === "SUPERSEDED" || cause === "WITHDRAWN" || cause === "EXPIRED"
        ? "The customer's quote was replaced after they paid. You cannot take this payment; decline the order to cancel the authorization."
        : "This payment cannot be taken: the quote or the authorization no longer matches. Decline the order to cancel it, or reload the page.";
    case "FINANCIAL_EXCEPTION":
      return "PayPal's records did not match what was expected. Nothing is marked as paid; the order is listed under needs attention.";
    case "OUTCOME_UNKNOWN":
      return "PayPal did not answer. We are checking it and will not send the request twice. The order is listed under being checked.";
    case "PROVIDER_REFUSED":
      return "PayPal refused the request. The order is still waiting; try again later.";
    case "PROVIDER_UNREACHABLE":
      return "PayPal could not be reached. Nothing was sent. Try again in a moment.";
    case "NOT_FOUND":
      return "That order was not found.";
    case "ILLEGAL_TRANSITION":
    case "ATTEMPT_ACTIVE":
      return "This order is not waiting for a decision any more. Reload the page.";
    default:
      return "That could not be done right now. Reload the page and try again.";
  }
}
