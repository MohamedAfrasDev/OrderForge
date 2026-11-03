import { INQUIRY_STATUSES, type InquiryEvent, type InquiryStatus } from "./types";

export { INQUIRY_STATUSES };

const ILLEGAL = { error: "ILLEGAL_TRANSITION" } as const;

/**
 * The only inquiry state machine. A move is the listed target or ILLEGAL_TRANSITION. Asking again while already clarifying, and
 * clearing again while already configuring, stay where they are (the next question, a fresh proposal). A handed-over inquiry
 * leaves only through the merchant. A new inquiry starts at NEW; no event creates one.
 */
export function inquiryTransition(from: InquiryStatus | null, event: InquiryEvent): InquiryStatus | typeof ILLEGAL {
  if (from === null) return ILLEGAL;
  switch (event.type) {
    case "ASK":
      return from === "NEW" || from === "CLARIFYING" || from === "CONFIGURING" ? "CLARIFYING" : ILLEGAL;
    case "CLEAR":
      return from === "NEW" || from === "CLARIFYING" || from === "CONFIGURING" ? "CONFIGURING" : ILLEGAL;
    case "QUOTE_PUBLISHED":
      return from === "CONFIGURING" ? "QUOTE_READY" : ILLEGAL;
    case "HAND_OFF":
      return from === "NEW" || from === "CLARIFYING" || from === "CONFIGURING" ? "REVIEW_REQUIRED" : ILLEGAL;
    case "CUSTOMER_CHANGE":
      return from === "QUOTE_READY" ? "CONFIGURING" : ILLEGAL;
    case "MERCHANT_RESOLVE":
      return from === "REVIEW_REQUIRED" && (event.to === "CONFIGURING" || event.to === "QUOTE_READY") ? event.to : ILLEGAL;
  }
}
