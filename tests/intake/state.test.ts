import { describe, expect, it } from "vitest";
import { INQUIRY_STATUSES, inquiryTransition, type InquiryEvent, type InquiryStatus } from "@/domain/intake";

const ILLEGAL = { error: "ILLEGAL_TRANSITION" };

const EVENTS: Array<{ name: string; event: InquiryEvent }> = [
  { name: "ASK", event: { type: "ASK" } },
  { name: "CLEAR", event: { type: "CLEAR" } },
  { name: "QUOTE_PUBLISHED", event: { type: "QUOTE_PUBLISHED" } },
  { name: "HAND_OFF", event: { type: "HAND_OFF" } },
  { name: "CUSTOMER_CHANGE", event: { type: "CUSTOMER_CHANGE" } },
  { name: "MERCHANT_RESOLVE to CONFIGURING", event: { type: "MERCHANT_RESOLVE", to: "CONFIGURING" } },
  { name: "MERCHANT_RESOLVE to QUOTE_READY", event: { type: "MERCHANT_RESOLVE", to: "QUOTE_READY" } },
];

// Written separately from the implementation: the legal target for each (state, event); everything else is refused.
const LEGAL: Record<string, Partial<Record<InquiryStatus, InquiryStatus>>> = {
  ASK: { NEW: "CLARIFYING", CLARIFYING: "CLARIFYING", CONFIGURING: "CLARIFYING" },
  CLEAR: { NEW: "CONFIGURING", CLARIFYING: "CONFIGURING", CONFIGURING: "CONFIGURING" },
  QUOTE_PUBLISHED: { CONFIGURING: "QUOTE_READY" },
  HAND_OFF: { NEW: "REVIEW_REQUIRED", CLARIFYING: "REVIEW_REQUIRED", CONFIGURING: "REVIEW_REQUIRED" },
  CUSTOMER_CHANGE: { QUOTE_READY: "CONFIGURING" },
  "MERCHANT_RESOLVE to CONFIGURING": { REVIEW_REQUIRED: "CONFIGURING" },
  "MERCHANT_RESOLVE to QUOTE_READY": { REVIEW_REQUIRED: "QUOTE_READY" },
};

describe("inquiry transition table", () => {
  it("lists the five statuses", () => {
    expect([...INQUIRY_STATUSES].sort()).toEqual(["CLARIFYING", "CONFIGURING", "NEW", "QUOTE_READY", "REVIEW_REQUIRED"]);
  });

  for (const { name, event } of EVENTS) {
    for (const from of INQUIRY_STATUSES) {
      const to = LEGAL[name]![from];
      it(`${from} + ${name} is ${to ? `allowed (-> ${to})` : "refused"}`, () => {
        expect(inquiryTransition(from, event)).toEqual(to ?? ILLEGAL);
      });
    }
  }

  it("a new inquiry starts at NEW and nothing creates it by transition", () => {
    for (const { event } of EVENTS) expect(inquiryTransition(null, event)).toEqual(ILLEGAL);
  });

  it("a handed-over inquiry only leaves through the merchant", () => {
    for (const event of [{ type: "ASK" }, { type: "CLEAR" }, { type: "QUOTE_PUBLISHED" }, { type: "HAND_OFF" }, { type: "CUSTOMER_CHANGE" }] as InquiryEvent[]) {
      expect(inquiryTransition("REVIEW_REQUIRED", event)).toEqual(ILLEGAL);
    }
  });

  it("a merchant can resolve only to CONFIGURING or QUOTE_READY", () => {
    expect(inquiryTransition("REVIEW_REQUIRED", { type: "MERCHANT_RESOLVE", to: "NEW" as never })).toEqual(ILLEGAL);
    expect(inquiryTransition("REVIEW_REQUIRED", { type: "MERCHANT_RESOLVE", to: "CLARIFYING" as never })).toEqual(ILLEGAL);
  });
});
