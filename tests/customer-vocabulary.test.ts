// Every message a customer can read about their price, their payment and their order is in the customer's vocabulary: no forbidden
// word (quote, authorize, capture, void, job, ...), no "merchant" (the glossary says "shop"), sentence case, ends with a full stop.
import { describe, expect, it } from "vitest";
import type { QuoteErrorCode } from "@/domain/quote";
import { forbiddenIn } from "@/domain/journey";
import { jobMessage } from "@/services/fulfillment/customer-messages";
import { PAYMENT_NOTICES, noticeMessage, statusMessage } from "@/services/payments/customer-messages";
import { acceptFailureMessage } from "@/services/quote/customer-messages";

const QUOTE_CODES: QuoteErrorCode[] = [
  "CONFIGURATION_BLOCKED", "NOT_DRAFT", "NOT_PUBLISHED", "SUPERSEDED", "EXPIRED", "WITHDRAWN", "HASH_MISMATCH",
  "QUOTE_TAMPERED", "QUOTE_STALE", "MERCHANT_REVIEW_REQUIRED", "MERCHANT_ONLY", "PAYMENT_STARTED", "NOT_FOUND",
  "INVALID_INPUT", "ILLEGAL_TRANSITION",
];

const PAYMENT_STATUSES = ["PAYING", "WAITING_MERCHANT", "CHECKING", "PAID", "DECLINED", "FAILED"] as const;
const JOB_STATUSES = ["PREPARING", "READY", "COLLECTED", "DELAYED"] as const;

const all: Array<[string, string]> = [
  ...PAYMENT_NOTICES.map((n) => [`payment notice ${n}`, noticeMessage(n)] as [string, string]),
  ...PAYMENT_STATUSES.map((s) => [`payment status ${s}`, statusMessage(s) ?? ""] as [string, string]),
  ...JOB_STATUSES.map((s) => [`order status ${s}`, jobMessage(s, "2026-11-10")] as [string, string]),
  ...QUOTE_CODES.map((c) => [`price acceptance ${c}`, acceptFailureMessage(c)] as [string, string]),
];

describe("what a customer reads about their price, payment and order", () => {
  it("covers every notice, status and error code", () => {
    expect(all.length).toBe(PAYMENT_NOTICES.length + PAYMENT_STATUSES.length + JOB_STATUSES.length + QUOTE_CODES.length);
    for (const [where, text] of all) expect(text.length, where).toBeGreaterThan(10);
  });

  it.each(all)("%s uses the customer's vocabulary", (where, text) => {
    expect(forbiddenIn(text), `${where}: ${text}`).toEqual([]);
    expect(text, where).not.toMatch(/\bmerchants?\b/i);
    expect(text, where).not.toMatch(/!/);
  });

  it.each(all)("%s is sentence case and ends with a full stop", (where, text) => {
    expect(text[0], where).toBe(text[0]!.toUpperCase());
    expect(text, where).toMatch(/\.$/);
  });

  it("says what PayPal did and did not do, accurately", () => {
    expect(noticeMessage("DONE")).toMatch(/approved the payment/i);
    expect(statusMessage("WAITING_MERCHANT")).toMatch(/only if the shop accepts/i);
    expect(statusMessage("DECLINED")).toMatch(/weren't charged/i);
    expect(noticeMessage("PROVIDER_REFUSED")).toMatch(/nothing was taken/i);
    expect(noticeMessage("OUTCOME_UNKNOWN")).toMatch(/don't pay again/i);
  });

  it("keeps the facts: no amount, id or code is invented in these messages", () => {
    for (const [where, text] of all) {
      expect(text, where).not.toMatch(/\$\d/);
      expect(text, where).not.toMatch(/[A-Z]{4,}_[A-Z_]+/);
    }
  });

  it("the preparing and delayed messages carry the date they are given", () => {
    expect(jobMessage("PREPARING", "2026-11-10")).toContain("2026-11-10");
    expect(jobMessage("DELAYED", "2026-11-10")).toContain("2026-11-10");
  });
});
