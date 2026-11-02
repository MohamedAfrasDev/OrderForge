import type { QuoteErrorCode } from "@/domain/quote";

/** What the merchant is told when publishing or withdrawing fails. Plain words only: no codes or ids. */
export function merchantFailureMessage(code: QuoteErrorCode): string {
  switch (code) {
    case "INVALID_INPUT":
      return "Write the wording the customer will see (publishing) or a reason (withdrawing), up to 500 characters.";
    case "MERCHANT_REVIEW_REQUIRED":
      return "This quote has an item that needs your decision. Write your wording and approve it to publish.";
    case "NOT_DRAFT":
      return "This quote is no longer a draft, so it was already published or withdrawn. Reload the list.";
    case "ILLEGAL_TRANSITION":
      return "This quote can no longer be changed here. Reload the list.";
    case "PAYMENT_STARTED":
      return "The customer's payment has already started on the accepted quote. Void that payment first, then publish the new version.";
    case "NOT_FOUND":
      return "That quote was not found.";
    default:
      return "That could not be done right now. Reload the list and try again.";
  }
}
