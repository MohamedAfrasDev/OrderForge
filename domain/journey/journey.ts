import type { InquiryStatus } from "@/domain/intake";
import { STEP_IDS, STEP_LABELS, WORDS, type StepId, type WordsKey } from "./wording";

export type StepState = "done" | "current" | "upcoming" | "stopped";

/**
 * What the order room already knows, as plain values. `payment` and `job` come from the customer's own payment and job views and are
 * read only once the price is accepted; before that they are ignored whatever they say.
 */
export type JourneyInput = {
  inquiry: InquiryStatus;
  quote: "NONE" | "PUBLISHED" | "EXPIRED" | "ACCEPTED";
  payment: "NONE" | "PAYING" | "WAITING_MERCHANT" | "CHECKING" | "PAID" | "DECLINED" | "FAILED" | null;
  job: "PREPARING" | "READY" | "COLLECTED" | "DELAYED" | null;
  /**
   * A customer message the assistant has not answered (it failed or is not done). Matters only before a price exists and while the
   * request is not with the shop: the header must not say "reading your request" forever.
   */
  stalled?: boolean;
};

export type JourneyStep = { id: StepId; label: string; state: StepState };

export type Journey = {
  steps: JourneyStep[];
  /** 0-based index of the step the customer is on; 6 (the number of steps) when everything is done. */
  current: number;
  headline: string;
  detail: string;
  waitingOn: "you" | "shop" | "nobody";
};

type Situation = { step: number; key: WordsKey; waitingOn: Journey["waitingOn"]; stopped?: true };

const DESCRIBE = 0;
const CHOOSE = 1;
const PRICE = 2;
const APPROVE = 3;
const CONFIRM = 4;
const PICKUP = 5;
const ALL_DONE = 6;

function situationOf(input: JourneyInput): Situation {
  // An accepted price outranks the inquiry's own status: from there the story is payment, then the shop's work.
  if (input.quote === "ACCEPTED") {
    switch (input.payment) {
      case "PAYING":
        return { step: APPROVE, key: "approving", waitingOn: "you" };
      case "FAILED":
        return { step: APPROVE, key: "payFailed", waitingOn: "you" };
      case "WAITING_MERCHANT":
        return { step: CONFIRM, key: "waitingShop", waitingOn: "shop" };
      case "CHECKING":
        return { step: CONFIRM, key: "checkingPayment", waitingOn: "nobody" };
      case "DECLINED":
        return { step: CONFIRM, key: "declined", waitingOn: "nobody", stopped: true };
      case "PAID":
        switch (input.job) {
          case "READY":
            return { step: PICKUP, key: "ready", waitingOn: "you" };
          case "COLLECTED":
            return { step: ALL_DONE, key: "collected", waitingOn: "nobody" };
          case "DELAYED":
            return { step: PICKUP, key: "delayed", waitingOn: "shop" };
          default:
            return { step: PICKUP, key: "preparing", waitingOn: "shop" };
        }
      default:
        // NONE, or not read yet: the customer still has to approve.
        return { step: APPROVE, key: "approve", waitingOn: "you" };
    }
  }
  if (input.quote === "EXPIRED") return { step: PRICE, key: "priceExpired", waitingOn: "you", stopped: true };
  if (input.quote === "PUBLISHED") return { step: PRICE, key: "reviewPrice", waitingOn: "you" };

  if (input.stalled && (input.inquiry === "NEW" || input.inquiry === "CLARIFYING" || input.inquiry === "CONFIGURING")) {
    return { step: input.inquiry === "CONFIGURING" ? CHOOSE : DESCRIBE, key: "stalled", waitingOn: "you" };
  }
  switch (input.inquiry) {
    case "NEW":
      return { step: DESCRIBE, key: "reading", waitingOn: "nobody" };
    case "CLARIFYING":
      return { step: DESCRIBE, key: "needAnswer", waitingOn: "you" };
    case "CONFIGURING":
      return { step: CHOOSE, key: "choose", waitingOn: "you" };
    case "REVIEW_REQUIRED":
      return { step: CHOOSE, key: "withShop", waitingOn: "shop" };
    case "QUOTE_READY":
      // A price is ready but not one the customer can see (yet): it is on its way.
      return { step: PRICE, key: "pricePreparing", waitingOn: "nobody" };
  }
}

/**
 * Where a customer is in their order, in their words: six steps marked done, current, still to come or stopped, a headline that says
 * what happens next, one sentence of detail, and who it waits on. Pure and total: every combination of states has an answer, and all
 * the wording comes from the glossary.
 */
export function journeyOf(input: JourneyInput): Journey {
  const now = situationOf(input);
  const steps: JourneyStep[] = STEP_IDS.map((id, i) => ({
    id,
    label: STEP_LABELS[i]!,
    state: i < now.step ? "done" : i === now.step ? (now.stopped ? "stopped" : "current") : "upcoming",
  }));
  const words = WORDS[now.key];
  return { steps, current: now.step, headline: words.headline, detail: words.detail, waitingOn: now.waitingOn };
}
