import type { QuoteErrorCode } from "@/domain/quote";

/** What the customer is told when accepting fails. Plain words only: no codes, hashes, stock figures or ids. */
export function acceptFailureMessage(code: QuoteErrorCode): string {
  switch (code) {
    case "HASH_MISMATCH":
      return "This price changed since you opened the page. Reload to see the current one before accepting.";
    case "SUPERSEDED":
      return "The shop sent you a newer version of this price. Reload the page to see it.";
    case "EXPIRED":
      return "This price has expired. Ask the shop for a new one.";
    case "WITHDRAWN":
      return "The shop withdrew this price. Ask them for an updated one.";
    case "QUOTE_STALE":
    case "CONFIGURATION_BLOCKED":
      return "Prices or availability changed, so this price can't be accepted as it is. The shop will need to send you an updated one.";
    case "NOT_PUBLISHED":
    case "NOT_FOUND":
      return "This price isn't available to accept.";
    default:
      return "This price can't be accepted right now. Contact the shop.";
  }
}
