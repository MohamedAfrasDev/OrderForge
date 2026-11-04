// Every word a customer reads about where their order stands comes from one module. This scans all of it.
import { describe, expect, it } from "vitest";
import { FORBIDDEN, STEP_LABELS, WORDS, forbiddenIn } from "@/domain/journey";

const strings = [
  ...STEP_LABELS.map((label, i) => [`step ${i + 1} label`, label] as const),
  ...Object.entries(WORDS).flatMap(([key, w]) => [[`${key} headline`, w.headline] as const, [`${key} detail`, w.detail] as const]),
];

describe("the customer glossary", () => {
  it("has six step labels and a headline and detail for every situation", () => {
    expect(STEP_LABELS).toEqual(["Describe", "Choose", "Review price", "Approve", "Shop confirms", "Pick up"]);
    expect(Object.keys(WORDS).length).toBeGreaterThanOrEqual(17);
  });

  it.each(strings)("%s uses no raw state, code, id or forbidden word", (_where, text) => {
    expect(forbiddenIn(text), text).toEqual([]);
  });

  it("the check itself catches what it should", () => {
    const bad = [
      "Your quote is ready",
      "Please wait",
      "Payment was authorized",
      "Captured",
      "The hold was voided",
      "Your inquiry",
      "REVIEW_REQUIRED",
      "Status: CONFIGURING",
      "Sent successfully",
      "SKU ABC-123",
      "Your job",
      "The worksheet",
      "The hash",
    ];
    for (const text of bad) expect(forbiddenIn(text), text).not.toEqual([]);
    for (const fine of ["Your price is ready", "Waiting for the shop to confirm", "PayPal is holding your payment", "You weren't charged"]) {
      expect(forbiddenIn(fine), fine).toEqual([]);
    }
    expect(FORBIDDEN.length).toBeGreaterThan(8);
  });

  it("follows the writing rules: sentence case, headlines without a full stop, one-sentence details that end with one", () => {
    for (const [where, text] of strings) {
      expect(text[0], where).toBe(text[0]!.toUpperCase());
      expect(text, where).not.toMatch(/!/);
      expect(text, where).not.toMatch(/\.{3}|…/);
      expect(text, where).not.toMatch(/&/);
    }
    for (const [key, w] of Object.entries(WORDS)) {
      expect(w.headline, key).not.toMatch(/[.?]$/);
      expect(w.headline.length, key).toBeLessThanOrEqual(60);
      expect(w.detail, key).toMatch(/\.$/);
      expect((w.detail.match(/[.?!](\s|$)/g) ?? []).length, `${key} is one sentence`).toBe(1);
      expect(w.detail.length, key).toBeLessThanOrEqual(160);
    }
  });

  it("states what PayPal does accurately: the money is set aside, and charged only if the shop accepts", () => {
    expect(WORDS.approve.detail).toMatch(/set[s]? the money aside/i);
    expect(WORDS.approve.detail).toMatch(/only if the shop accepts/i);
    expect(WORDS.declined.detail).toMatch(/weren't charged/i);
    expect(WORDS.reviewPrice.detail).toMatch(/nothing is charged/i);
  });
});
