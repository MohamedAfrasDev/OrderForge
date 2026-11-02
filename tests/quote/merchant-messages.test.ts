import { describe, expect, it } from "vitest";
import type { QuoteErrorCode } from "@/domain/quote";
import { merchantFailureMessage } from "@/services/quote/merchant-messages";

const ALL: QuoteErrorCode[] = [
  "CONFIGURATION_BLOCKED", "NOT_DRAFT", "NOT_PUBLISHED", "SUPERSEDED", "EXPIRED", "WITHDRAWN", "HASH_MISMATCH",
  "QUOTE_TAMPERED", "QUOTE_STALE", "MERCHANT_REVIEW_REQUIRED", "MERCHANT_ONLY", "PAYMENT_STARTED", "NOT_FOUND",
  "INVALID_INPUT", "ILLEGAL_TRANSITION",
];

describe("merchantFailureMessage", () => {
  it("has a message for every error code", () => {
    for (const code of ALL) expect(merchantFailureMessage(code).length, code).toBeGreaterThan(10);
  });

  it("says what to do for the cases a merchant can fix", () => {
    expect(merchantFailureMessage("INVALID_INPUT")).toMatch(/wording|reason/i);
    expect(merchantFailureMessage("PAYMENT_STARTED")).toMatch(/payment/i);
    expect(merchantFailureMessage("NOT_DRAFT")).toMatch(/already|no longer/i);
  });

  it("never shows a raw error code", () => {
    for (const code of ALL) expect(merchantFailureMessage(code), code).not.toMatch(/[A-Z]{4,}_[A-Z_]+/);
  });
});
