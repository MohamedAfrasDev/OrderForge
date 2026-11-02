import { describe, expect, it } from "vitest";
import { buildQuoteSnapshot, quoteHash } from "@/domain/quote/snapshot";
import type { Condition, QuoteSnapshot } from "@/domain/quote/types";
import { sha256Hex } from "@/lib/hash";
import { cents, mulInt, sum } from "@/lib/money";
import { chance, createRng, int, shuffled, type Rng } from "../catalog/random";

const CODES = ["PRODUCTION_SLOT_CONFIRMATION", "ARTWORK_ACCEPTANCE", "MERCHANT_APPROVED_CUSTOMIZATION"] as const;

function randomSnapshot(rng: Rng): QuoteSnapshot {
  const lines = Array.from({ length: int(rng, 1, 6) }, (_, i) => ({
    slotId: `slot${i}`,
    sku: `SKU-${int(rng, 1, 99)}`,
    name: `Item ${int(rng, 1, 999)}`,
    unitPriceMinor: cents(int(rng, 1, 5000)),
    quantity: int(rng, 1, 3),
  }));
  const perBoxMinor = sum(lines.map((l) => mulInt(l.unitPriceMinor, l.quantity)));
  const boxCount = int(rng, 1, 200);
  const conditions: Condition[] = Array.from({ length: int(rng, 0, 3) }, () => ({
    code: CODES[int(rng, 0, CODES.length - 1)]!,
    text: `text ${int(rng, 1, 50)}`,
  }));
  return buildQuoteSnapshot({
    merchantId: "0c9e6a52-3d41-4b8a-a7f4-6e2b9d1c5f33",
    inquiryId: "5b1f0f0e-6c0b-4f6e-9c58-0f3a3f1d2a11",
    version: int(rng, 1, 9),
    requirementVersionId: chance(rng, 0.5) ? "7d2c9a54-1c5e-4a7b-8e3f-2b6d4c8e9f10" : null,
    priced: { lines, perBoxMinor, boxCount, totalMinor: mulInt(perBoxMinor, boxCount), currency: "USD" },
    conditions,
  });
}

describe("quote hash properties (seeded)", () => {
  it("is stable on repeat and independent of key order, for 200 random snapshots", () => {
    const rng = createRng(2026);
    for (let i = 0; i < 200; i++) {
      const s = randomSnapshot(rng);
      const h = quoteHash(s, sha256Hex);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(quoteHash(structuredClone(s), sha256Hex)).toBe(h);
      const keys = shuffled(rng, Object.keys(s)) as Array<keyof QuoteSnapshot>;
      const reordered = Object.fromEntries(keys.map((k) => [k, s[k]])) as unknown as QuoteSnapshot;
      expect(quoteHash(reordered, sha256Hex)).toBe(h);
    }
  });

  it("different totals never share a hash within the sample", () => {
    const rng = createRng(7);
    const byTotal = new Map<number, string>();
    const seen = new Map<string, string>();
    for (let i = 0; i < 300; i++) {
      const s = randomSnapshot(rng);
      const h = quoteHash(s, sha256Hex);
      const body = JSON.stringify(s);
      const earlier = seen.get(h);
      if (earlier !== undefined) expect(earlier).toBe(body); // same hash only for the same content
      seen.set(h, body);
      byTotal.set(s.totalMinor, h);
    }
    expect(byTotal.size).toBeGreaterThan(50);
  });
});
