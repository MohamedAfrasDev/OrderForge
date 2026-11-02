import { describe, expect, it } from "vitest";
import type { QuoteErrorCode } from "@/domain/quote";
import { acceptFailureMessage } from "@/services/quote/customer-messages";

const ALL: QuoteErrorCode[] = [
  "CONFIGURATION_BLOCKED", "NOT_DRAFT", "NOT_PUBLISHED", "SUPERSEDED", "EXPIRED", "WITHDRAWN", "HASH_MISMATCH",
  "QUOTE_TAMPERED", "QUOTE_STALE", "MERCHANT_REVIEW_REQUIRED", "MERCHANT_ONLY", "PAYMENT_STARTED", "NOT_FOUND",
  "INVALID_INPUT", "ILLEGAL_TRANSITION",
];

describe("acceptFailureMessage", () => {
  it("has a non-empty message for every error code", () => {
    for (const code of ALL) expect(acceptFailureMessage(code).length, code).toBeGreaterThan(10);
  });

  it("tells the customer what to do for the recoverable cases", () => {
    expect(acceptFailureMessage("HASH_MISMATCH")).toMatch(/reload/i);
    expect(acceptFailureMessage("SUPERSEDED")).toMatch(/newer version/i);
    expect(acceptFailureMessage("EXPIRED")).toMatch(/expired/i);
    expect(acceptFailureMessage("QUOTE_STALE")).toMatch(/merchant/i);
  });

  it("never exposes internals: no code names, hashes, ids or stock", () => {
    for (const code of ALL) {
      const text = acceptFailureMessage(code);
      expect(text, code).not.toMatch(/[A-Z]{4,}_[A-Z_]+/);
      expect(text, code).not.toMatch(/hash|tamper|stock|blocker|database/i);
    }
  });
});
