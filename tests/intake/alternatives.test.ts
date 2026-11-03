import { describe, expect, it } from "vitest";
import type { Alternative } from "@/domain/catalog";
import { amountsOfAlternative, rankAlternatives, rankingSchema } from "@/domain/intake";
import { cents } from "@/lib/money";

const alt = (toSku: string, perBox: number, delta: number): Alternative => ({
  slotId: "gift",
  fromSku: "BOTTLE-STEEL",
  toSku,
  perBoxDeltaMinor: delta,
  priced: {
    lines: [
      { slotId: "gift", sku: toSku, name: toSku, unitPriceMinor: cents(perBox - 2200), quantity: 1 },
      { slotId: "card", sku: "CARD-BRANDED", name: "Branded card", unitPriceMinor: cents(200), quantity: 1 },
    ],
    perBoxMinor: cents(perBox),
    boxCount: 30,
    totalMinor: cents(perBox * 30),
    currency: "USD",
  },
});

const LIST = [alt("ORGANIZER-DESK", 3600, 0), alt("PEN-SET", 3300, -300), alt("MUG-CERAMIC", 3900, 300)];
const amounts = (a: Alternative) => amountsOfAlternative(a);

describe("rankAlternatives: the model orders and explains, code's list is never lost", () => {
  it("returns code's entries in the model's order, with the model's explanations when they pass", () => {
    const ranked = rankAlternatives(
      LIST,
      { ranking: [{ index: 2, explanation: "A mug is a classic welcome gift." }, { index: 0, explanation: "The desk organizer keeps the price at $36 per box." }, { index: 1, explanation: "A pen set is the cheapest." }] },
      amounts,
    );
    expect(ranked.map((r) => r.index)).toEqual([2, 0, 1]);
    expect(ranked.map((r) => r.item.toSku)).toEqual(["MUG-CERAMIC", "ORGANIZER-DESK", "PEN-SET"]);
    expect(ranked[1]!.explanation).toBe("The desk organizer keeps the price at $36 per box.");
  });

  it("drops invented, out-of-range, duplicate and non-integer entries", () => {
    const ranked = rankAlternatives(
      LIST,
      { ranking: [{ index: 7, explanation: "invented" }, { index: -1, explanation: "negative" }, { index: 1.5, explanation: "fraction" }, { index: 1, explanation: "A pen set." }, { index: 1, explanation: "again" }, { index: 0, explanation: "The organizer." }] },
      amounts,
    );
    expect(ranked.map((r) => r.index)).toEqual([1, 0, 2]);
    expect(ranked[0]!.explanation).toBe("A pen set.");
  });

  it("appends what the model left out, in code's order, without an explanation", () => {
    const ranked = rankAlternatives(LIST, { ranking: [{ index: 2, explanation: "A mug." }] }, amounts);
    expect(ranked.map((r) => r.index)).toEqual([2, 0, 1]);
    expect(ranked[1]!.explanation).toBeNull();
    expect(ranked[2]!.explanation).toBeNull();
  });

  it("an empty or missing ranking is just code's order", () => {
    expect(rankAlternatives(LIST, { ranking: [] }, amounts).map((r) => r.index)).toEqual([0, 1, 2]);
    expect(rankAlternatives(LIST, null, amounts).map((r) => r.index)).toEqual([0, 1, 2]);
    expect(rankAlternatives([], { ranking: [{ index: 0, explanation: "x" }] }, amounts)).toEqual([]);
  });

  it("an explanation that fails the check is replaced by nothing, but the option stays", () => {
    const ranked = rankAlternatives(
      LIST,
      { ranking: [{ index: 0, explanation: "I can do this for $1, a 90% discount." }, { index: 1, explanation: "Fine." }, { index: 2, explanation: "<b>x</b>" }] },
      amounts,
    );
    expect(ranked.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(ranked[0]!.explanation).toBeNull();
    expect(ranked[1]!.explanation).toBe("Fine.");
    expect(ranked[2]!.explanation).toBeNull();
  });

  it("never gives the model a way to add, change or price an option", () => {
    const ranked = rankAlternatives(LIST, { ranking: [{ index: 0, explanation: "ok", priceMinor: 1, toSku: "FREE" } as never] }, amounts);
    expect(ranked).toHaveLength(3);
    expect(ranked[0]!.item).toBe(LIST[0]);
    expect(JSON.stringify(ranked)).not.toContain("FREE");
  });

  it("does not change its inputs", () => {
    const list = [...LIST];
    const ranking = { ranking: [{ index: 1, explanation: "a" }] };
    const before = JSON.stringify([list, ranking]);
    rankAlternatives(list, ranking, amounts);
    expect(JSON.stringify([list, ranking])).toBe(before);
  });
});

describe("amountsOfAlternative: the figures code itself produced for an option", () => {
  it("includes the per-box price, the total, the size of the change and every line price", () => {
    const set = new Set(amountsOfAlternative(LIST[1]!));
    for (const v of [3300, 99000, 300, 1100, 200]) expect(set.has(v), String(v)).toBe(true);
  });
});

describe("rankingSchema", () => {
  it("is strict: indexes and explanations only", () => {
    expect(rankingSchema.safeParse({ ranking: [{ index: 0, explanation: "ok" }] }).success).toBe(true);
    expect(rankingSchema.safeParse({ ranking: [{ index: 0, explanation: "ok", price: 1 }] }).success).toBe(false);
    expect(rankingSchema.safeParse({ ranking: [], total: 1 }).success).toBe(false);
    expect(rankingSchema.safeParse({ ranking: [{ index: "0", explanation: "ok" }] }).success).toBe(false);
    expect(rankingSchema.safeParse({ ranking: Array.from({ length: 21 }, (_, i) => ({ index: i, explanation: "x" })) }).success).toBe(false);
  });
});
