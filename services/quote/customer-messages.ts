import type { QuoteErrorCode } from "@/domain/quote";

/** What the customer is told when accepting fails. Plain words only: no codes, hashes, stock figures or ids. */
export function acceptFailureMessage(code: QuoteErrorCode): string {
  switch (code) {
    case "HASH_MISMATCH":
      return "This quote changed since you opened the page. Reload to see the current version before accepting.";
    case "SUPERSEDED":
      return "The merchant sent a newer version of this quote. Reload the page to see it.";
    case "EXPIRED":
      return "This quote has expired. Ask the merchant for a new one.";
    case "WITHDRAWN":
      return "The merchant withdrew this quote. Ask them for an updated one.";
    case "QUOTE_STALE":
    case "CONFIGURATION_BLOCKED":
      return "Prices or availability changed, so this quote can no longer be accepted as it is. The merchant will need to send an updated quote.";
    case "NOT_PUBLISHED":
    case "NOT_FOUND":
      return "This quote is not available to accept.";
    default:
      return "This quote cannot be accepted right now. Please contact the merchant.";
  }
}
