import { describe, expect, it } from "vitest";
import { INQUIRY_STATUSES, type InquiryStatus } from "@/domain/intake";
import { WORDS, journeyOf, type JourneyInput } from "@/domain/journey";
import type { CustomerJobView } from "@/services/fulfillment/read";
import type { CustomerPaymentView } from "@/services/payments/read";

const QUOTES: JourneyInput["quote"][] = ["NONE", "PUBLISHED", "EXPIRED", "ACCEPTED"];
const PAYMENTS: JourneyInput["payment"][] = [null, "NONE", "PAYING", "WAITING_MERCHANT", "CHECKING", "PAID", "DECLINED", "FAILED"];
const JOBS: JourneyInput["job"][] = [null, "PREPARING", "READY", "COLLECTED", "DELAYED"];

// The input types describe the views the order room already reads: if one of those views gains a value, this stops compiling.
type PaymentCovered = CustomerPaymentView["status"] extends NonNullable<JourneyInput["payment"]> ? true : never;
type JobCovered = CustomerJobView["status"] extends NonNullable<JourneyInput["job"]> ? true : never;
const covered: [PaymentCovered, JobCovered] = [true, true];

const every = (): JourneyInput[] =>
  INQUIRY_STATUSES.flatMap((inquiry) =>
    QUOTES.flatMap((quote) => PAYMENTS.flatMap((payment) => JOBS.flatMap((job) => [false, true].map((stalled) => ({ inquiry, quote, payment, job, stalled }))))),
  );

const base: JourneyInput = { inquiry: "NEW" as InquiryStatus, quote: "NONE", payment: null, job: null };

describe("journeyOf: the strip and the headline at each stage (a table written apart from the function)", () => {
  // [description, input, current step (0-based; 6 means all done), state of that step, words key, who is next]
  const stages: Array<[string, Partial<JourneyInput>, number, "current" | "stopped" | "done", keyof typeof WORDS, "you" | "shop" | "nobody"]> = [
    ["a request just started", { inquiry: "NEW" }, 0, "current", "reading", "nobody"],
    ["a question is open", { inquiry: "CLARIFYING" }, 0, "current", "needAnswer", "you"],
    ["boxes are being chosen", { inquiry: "CONFIGURING" }, 1, "current", "choose", "you"],
    ["handed to the shop, no price yet", { inquiry: "REVIEW_REQUIRED" }, 1, "current", "withShop", "shop"],
    ["the assistant has not answered the first message", { inquiry: "NEW", stalled: true }, 0, "current", "stalled", "you"],
    ["the assistant has not answered a later message", { inquiry: "CLARIFYING", stalled: true }, 0, "current", "stalled", "you"],
    ["the assistant has not answered while choosing", { inquiry: "CONFIGURING", stalled: true }, 1, "current", "stalled", "you"],
    ["stalled but already with the shop", { inquiry: "REVIEW_REQUIRED", stalled: true }, 1, "current", "withShop", "shop"],
    ["stalled but a price is already there", { inquiry: "QUOTE_READY", quote: "PUBLISHED", stalled: true }, 2, "current", "reviewPrice", "you"],
    ["a price is ready but cannot be shown yet", { inquiry: "QUOTE_READY" }, 2, "current", "pricePreparing", "nobody"],
    ["a price to review", { inquiry: "QUOTE_READY", quote: "PUBLISHED" }, 2, "current", "reviewPrice", "you"],
    ["the price expired", { inquiry: "QUOTE_READY", quote: "EXPIRED" }, 2, "stopped", "priceExpired", "you"],
    ["accepted, not paying yet", { inquiry: "QUOTE_READY", quote: "ACCEPTED", payment: "NONE" }, 3, "current", "approve", "you"],
    ["accepted, the payment view not read yet", { inquiry: "QUOTE_READY", quote: "ACCEPTED", payment: null }, 3, "current", "approve", "you"],
    ["on the way to PayPal", { inquiry: "QUOTE_READY", quote: "ACCEPTED", payment: "PAYING" }, 3, "current", "approving", "you"],
    ["PayPal did not go through", { inquiry: "QUOTE_READY", quote: "ACCEPTED", payment: "FAILED" }, 3, "current", "payFailed", "you"],
    ["waiting for the shop", { inquiry: "QUOTE_READY", quote: "ACCEPTED", payment: "WAITING_MERCHANT" }, 4, "current", "waitingShop", "shop"],
    ["checking the payment", { inquiry: "QUOTE_READY", quote: "ACCEPTED", payment: "CHECKING" }, 4, "current", "checkingPayment", "nobody"],
    ["the shop declined", { inquiry: "QUOTE_READY", quote: "ACCEPTED", payment: "DECLINED" }, 4, "stopped", "declined", "nobody"],
    ["paid, no job yet", { inquiry: "QUOTE_READY", quote: "ACCEPTED", payment: "PAID", job: null }, 5, "current", "preparing", "shop"],
    ["paid, being prepared", { inquiry: "QUOTE_READY", quote: "ACCEPTED", payment: "PAID", job: "PREPARING" }, 5, "current", "preparing", "shop"],
    ["paid, delayed", { inquiry: "QUOTE_READY", quote: "ACCEPTED", payment: "PAID", job: "DELAYED" }, 5, "current", "delayed", "shop"],
    ["paid, ready for pickup", { inquiry: "QUOTE_READY", quote: "ACCEPTED", payment: "PAID", job: "READY" }, 5, "current", "ready", "you"],
    ["collected", { inquiry: "QUOTE_READY", quote: "ACCEPTED", payment: "PAID", job: "COLLECTED" }, 6, "done", "collected", "nobody"],
  ];

  it.each(stages)("%s", (_name, input, current, state, key, who) => {
    const j = journeyOf({ ...base, ...input });
    expect(j.current).toBe(current);
    expect(j.headline).toBe(WORDS[key].headline);
    expect(j.detail).toBe(WORDS[key].detail);
    expect(j.waitingOn).toBe(who);
    if (current < 6) expect(j.steps[current]!.state).toBe(state);
    else expect(j.steps.every((s) => s.state === "done")).toBe(true);
  });

  it("only reads the payment and the job once the price is accepted", () => {
    const ignored = journeyOf({ inquiry: "CONFIGURING", quote: "NONE", payment: "PAID", job: "COLLECTED" });
    expect(ignored).toEqual(journeyOf({ inquiry: "CONFIGURING", quote: "NONE", payment: null, job: null }));
    const published = journeyOf({ inquiry: "QUOTE_READY", quote: "PUBLISHED", payment: "DECLINED", job: "READY" });
    expect(published.current).toBe(2);
  });

  it("an accepted price outranks the inquiry status, whatever it says", () => {
    for (const inquiry of INQUIRY_STATUSES) {
      expect(journeyOf({ inquiry, quote: "ACCEPTED", payment: "WAITING_MERCHANT", job: null }).current, inquiry).toBe(4);
    }
  });

  it("a stalled assistant only matters before a price and before the shop has the request", () => {
    for (const inquiry of INQUIRY_STATUSES) {
      for (const quote of QUOTES) {
        const stalled = journeyOf({ ...base, inquiry, quote, stalled: true });
        const plain = journeyOf({ ...base, inquiry, quote });
        const matters = quote === "NONE" && (inquiry === "NEW" || inquiry === "CLARIFYING" || inquiry === "CONFIGURING");
        if (matters) {
          expect(stalled.headline, `${inquiry}/${quote}`).toBe(WORDS.stalled.headline);
          expect(stalled.current, `${inquiry}/${quote}`).toBe(plain.current);
        } else expect(stalled, `${inquiry}/${quote}`).toEqual(plain);
      }
    }
  });

  it("the steps carry the glossary's labels in order", () => {
    expect(journeyOf(base).steps.map((s) => s.label)).toEqual(["Describe", "Choose", "Review price", "Approve", "Shop confirms", "Pick up"]);
    expect(new Set(journeyOf(base).steps.map((s) => s.id)).size).toBe(6);
  });
});

describe("journeyOf: true for every combination of states", () => {
  const all = every();

  it("covers 1,600 combinations and the input types cover the views", () => {
    expect(all).toHaveLength(5 * 4 * 8 * 5 * 2);
    expect(covered).toEqual([true, true]);
  });

  it("always names six steps with at most one that is current or stopped, done before it and upcoming after it", () => {
    for (const input of all) {
      const j = journeyOf(input);
      const where = JSON.stringify(input);
      expect(j.steps, where).toHaveLength(6);
      expect(j.current, where).toBeGreaterThanOrEqual(0);
      expect(j.current, where).toBeLessThanOrEqual(6);
      j.steps.forEach((s, i) => {
        if (j.current === 6 || i < j.current) expect(s.state, where).toBe("done");
        else if (i === j.current) expect(["current", "stopped"], where).toContain(s.state);
        else expect(s.state, where).toBe("upcoming");
      });
    }
  });

  it("always has a headline and detail from the glossary, and a valid next-up", () => {
    const headlines = new Set<string>(Object.values(WORDS).map((w) => w.headline));
    const details = new Set<string>(Object.values(WORDS).map((w) => w.detail));
    for (const input of all) {
      const j = journeyOf(input);
      expect(headlines.has(j.headline), JSON.stringify(input)).toBe(true);
      expect(details.has(j.detail), JSON.stringify(input)).toBe(true);
      expect(["you", "shop", "nobody"]).toContain(j.waitingOn);
    }
  });

  it("is pure: the same input gives the same answer and the input is not changed", () => {
    for (const input of all.slice(0, 200)) {
      const copy = { ...input };
      expect(journeyOf(input)).toEqual(journeyOf(input));
      expect(input).toEqual(copy);
    }
  });

  it("a stopped step is only ever a declined payment or an expired price", () => {
    for (const input of all) {
      const stopped = journeyOf(input).steps.some((s) => s.state === "stopped");
      const expected = input.quote === "EXPIRED" || (input.quote === "ACCEPTED" && input.payment === "DECLINED");
      expect(stopped, JSON.stringify(input)).toBe(expected);
    }
  });

  it("never goes backwards: each later fact moves the current step on or keeps it", () => {
    const stage = (p: Partial<JourneyInput>) => journeyOf({ ...base, ...p }).current;
    expect(stage({ inquiry: "NEW" })).toBeLessThanOrEqual(stage({ inquiry: "CONFIGURING" }));
    expect(stage({ inquiry: "CONFIGURING" })).toBeLessThanOrEqual(stage({ inquiry: "QUOTE_READY", quote: "PUBLISHED" }));
    expect(stage({ inquiry: "QUOTE_READY", quote: "PUBLISHED" })).toBeLessThanOrEqual(stage({ quote: "ACCEPTED", payment: "NONE" }));
    const paid = (job: JourneyInput["job"]) => stage({ quote: "ACCEPTED", payment: "PAID", job });
    expect(stage({ quote: "ACCEPTED", payment: "WAITING_MERCHANT" })).toBeLessThanOrEqual(paid(null));
    expect(paid("PREPARING")).toBeLessThanOrEqual(paid("READY"));
    expect(paid("READY")).toBeLessThanOrEqual(paid("COLLECTED"));
  });
});
