import { describe, expect, it } from "vitest";
import { calculateQuote } from "@/domain/catalog";
import { canonicalJson } from "@/domain/quote/canonical";
import { buildQuoteSnapshot, quoteHash, renderTerms, TERMS_SENTENCE } from "@/domain/quote/snapshot";
import type { Condition, QuoteSnapshot } from "@/domain/quote/types";
import { sha256Hex } from "@/lib/hash";
import { cents } from "@/lib/money";
import { demoCatalog, withGift } from "../catalog/fixtures";

const ids = {
  merchantId: "0c9e6a52-3d41-4b8a-a7f4-6e2b9d1c5f33",
  inquiryId: "5b1f0f0e-6c0b-4f6e-9c58-0f3a3f1d2a11",
  requirementVersionId: "7d2c9a54-1c5e-4a7b-8e3f-2b6d4c8e9f10",
};

// Demo step D: 30 boxes with the organizer = 3600 per box, 108000 total.
const priced = calculateQuote({ boxCount: 30, selections: withGift("ORG-01") }, demoCatalog);
const base = (over: Partial<Parameters<typeof buildQuoteSnapshot>[0]> = {}) =>
  buildQuoteSnapshot({ ...ids, version: 1, priced, conditions: [], ...over });

// Written by hand, not produced by canonicalJson, and hashed with node:crypto outside this repo's code.
const GOLDEN_CANONICAL =
  '{"boxCount":30,"conditions":[],"currency":"USD","inquiryId":"5b1f0f0e-6c0b-4f6e-9c58-0f3a3f1d2a11","lines":[{"name":"Notebook","quantity":1,"sku":"NB-01","slotId":"notebook","unitPriceMinor":1200},{"name":"Pen","quantity":1,"sku":"PN-01","slotId":"pen","unitPriceMinor":300},{"name":"Desk organizer","quantity":1,"sku":"ORG-01","slotId":"gift","unitPriceMinor":1400},{"name":"Branded card","quantity":1,"sku":"CARD-01","slotId":"card","unitPriceMinor":200},{"name":"Gift packaging","quantity":1,"sku":"PKG-01","slotId":"packaging","unitPriceMinor":500}],"merchantId":"0c9e6a52-3d41-4b8a-a7f4-6e2b9d1c5f33","perBoxMinor":3600,"requirementVersionId":"7d2c9a54-1c5e-4a7b-8e3f-2b6d4c8e9f10","schema":"orderforge.quote.v1","totalMinor":108000,"version":1}';
const GOLDEN_HASH = "aeb92d2b3f159e572e66fb7dcda98476580597a629e92758d0d9e292fe809724";

describe("buildQuoteSnapshot", () => {
  it("carries the priced demo quote: 3600 per box, 108000 total", () => {
    const s = base();
    expect(s.perBoxMinor).toBe(3600);
    expect(s.totalMinor).toBe(108000);
    expect(s.boxCount).toBe(30);
    expect(s.currency).toBe("USD");
    expect(s.lines.map((l) => l.slotId)).toEqual(["notebook", "pen", "gift", "card", "packaging"]);
  });

  it("copies only the covered line fields", () => {
    const withExtra = { ...priced, lines: priced.lines.map((l) => ({ ...l, discount: 5 })) };
    const s = buildQuoteSnapshot({ ...ids, version: 1, priced: withExtra, conditions: [] });
    expect(Object.keys(s.lines[0]).sort()).toEqual(["name", "quantity", "sku", "slotId", "unitPriceMinor"]);
  });

  it("sorts conditions by code then text and does not mutate the input", () => {
    const input: Condition[] = [
      { code: "PRODUCTION_SLOT_CONFIRMATION", text: "b" },
      { code: "ARTWORK_ACCEPTANCE", text: "z" },
      { code: "ARTWORK_ACCEPTANCE", text: "a" },
    ];
    const copy = structuredClone(input);
    const s = base({ conditions: input });
    expect(s.conditions.map((c) => `${c.code}:${c.text}`)).toEqual([
      "ARTWORK_ACCEPTANCE:a",
      "ARTWORK_ACCEPTANCE:z",
      "PRODUCTION_SLOT_CONFIRMATION:b",
    ]);
    expect(input).toEqual(copy);
  });

  it("accepts a null requirement version", () => {
    expect(base({ requirementVersionId: null }).requirementVersionId).toBeNull();
  });
});

describe("quoteHash", () => {
  it("canonical text and hash of the demo quote match the committed golden values", () => {
    expect(canonicalJson(base())).toBe(GOLDEN_CANONICAL);
    expect(quoteHash(base(), sha256Hex)).toBe(GOLDEN_HASH);
  });

  it("is stable on repeat and independent of key order", () => {
    const s = base();
    const reordered = Object.fromEntries(Object.entries(s).reverse()) as QuoteSnapshot;
    expect(quoteHash(reordered, sha256Hex)).toBe(quoteHash(s, sha256Hex));
    expect(quoteHash(base(), sha256Hex)).toBe(quoteHash(base(), sha256Hex));
  });

  it("is independent of the order conditions were supplied in", () => {
    const a: Condition = { code: "ARTWORK_ACCEPTANCE", text: "art" };
    const b: Condition = { code: "PRODUCTION_SLOT_CONFIRMATION", text: "slot" };
    expect(quoteHash(base({ conditions: [a, b] }), sha256Hex)).toBe(quoteHash(base({ conditions: [b, a] }), sha256Hex));
  });

  const original = quoteHash(base(), sha256Hex);
  const otherPriced = calculateQuote({ boxCount: 20, selections: withGift("BOT-01") }, demoCatalog);
  const renamed = { ...priced, lines: priced.lines.map((l, i) => (i === 0 ? { ...l, name: "Notebook A5" } : l)) };
  const repriced = { ...priced, lines: priced.lines.map((l, i) => (i === 0 ? { ...l, unitPriceMinor: cents(l.unitPriceMinor + 1) } : l)) };
  it.each([
    ["merchantId", base({ merchantId: "11111111-1111-4111-8111-111111111111" })],
    ["inquiryId", base({ inquiryId: "11111111-1111-4111-8111-111111111111" })],
    ["version", base({ version: 2 })],
    ["requirementVersionId", base({ requirementVersionId: "11111111-1111-4111-8111-111111111111" })],
    ["requirementVersionId null", base({ requirementVersionId: null })],
    ["a different box", base({ priced: otherPriced })],
    ["a line name", base({ priced: renamed })],
    ["a unit price", base({ priced: repriced })],
    ["a condition", base({ conditions: [{ code: "ARTWORK_ACCEPTANCE", text: "art" }] })],
  ])("changes when %s changes", (_name, changed) => {
    expect(quoteHash(changed, sha256Hex)).not.toBe(original);
  });

  it("changes when a condition's text changes", () => {
    const h1 = quoteHash(base({ conditions: [{ code: "ARTWORK_ACCEPTANCE", text: "one" }] }), sha256Hex);
    const h2 = quoteHash(base({ conditions: [{ code: "ARTWORK_ACCEPTANCE", text: "two" }] }), sha256Hex);
    expect(h1).not.toBe(h2);
  });

  it("returns 64 lowercase hex characters", () => {
    expect(original).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("renderTerms", () => {
  it("contains the fixed sentence, the version and the exact amounts", () => {
    const t = renderTerms(base());
    expect(t).toContain(TERMS_SENTENCE);
    expect(TERMS_SENTENCE).toBe(
      "You are authorizing this exact proposal, subject to the merchant confirming the listed production conditions.",
    );
    expect(t).toContain("30 boxes");
    expect(t).toContain("$36.00 per box");
    expect(t).toContain("$1,080.00");
    expect(t).toContain("version 1");
  });

  it("lists every disclosed condition", () => {
    const t = renderTerms(
      base({
        conditions: [
          { code: "PRODUCTION_SLOT_CONFIRMATION", text: "Slot pending." },
          { code: "ARTWORK_ACCEPTANCE", text: "Artwork pending." },
        ],
      }),
    );
    expect(t).toContain("Slot pending.");
    expect(t).toContain("Artwork pending.");
  });

  it("says there are no pending conditions when there are none", () => {
    expect(renderTerms(base())).toContain("No conditions are pending.");
  });

  it("is deterministic", () => {
    expect(renderTerms(base())).toBe(renderTerms(base()));
  });
});
