import type { CustomerStatus, FulfillmentErrorCode } from "@/domain/fulfillment";

const formatDay = (isoDay: string) => isoDay;

/** What a customer reads about their order once it is paid. Plain words: no ids, no notes, no internal statuses. */
export function jobMessage(status: CustomerStatus, readyBy: string): string {
  switch (status) {
    case "PREPARING":
      return `The shop is getting your order ready. They aim to have it ready by ${formatDay(readyBy)}.`;
    case "READY":
      return "Your order is ready for pickup.";
    case "COLLECTED":
      return "Your order has been collected. Thank you.";
    case "DELAYED":
      return `Your order is taking longer than planned. The shop will be in touch. It was due by ${formatDay(readyBy)}.`;
  }
}

/** What the merchant is told when moving a job fails. */
export function moveFailureMessage(code: FulfillmentErrorCode): string {
  switch (code) {
    case "NOTE_REQUIRED":
      return "Write a note for the hold (up to 500 characters).";
    case "ILLEGAL_TRANSITION":
      return "This job cannot be moved that way any more. Reload the page.";
    case "NOT_FOUND":
      return "That job was not found.";
    case "INVALID_INPUT":
      return "That could not be understood. Reload the page and try again.";
    default:
      return "That could not be done right now. Reload the page and try again.";
  }
}
