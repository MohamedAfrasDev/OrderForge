import { describe, expect, it } from "vitest";
import { add, cents, format, mulInt, roundHalfUp, sum } from "@/lib/money";

describe("cents", () => {
  it("accepts integers, including zero and negatives", () => {
    expect(cents(0)).toBe(0);
    expect(cents(1200)).toBe(1200);
    expect(cents(-50)).toBe(-50);
  });

  it.each([0.5, 12.34, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects %s",
    (n) => {
      expect(() => cents(n)).toThrow(RangeError);
    },
  );
});

describe("arithmetic", () => {
  it("adds minor units", () => {
    expect(add(cents(1200), cents(300))).toBe(1500);
  });

  it("multiplies by an integer quantity", () => {
    expect(mulInt(cents(3600), 30)).toBe(108000);
  });

  it("rejects a non-integer quantity", () => {
    expect(() => mulInt(cents(100), 1.5)).toThrow(RangeError);
  });

  it("throws instead of silently losing precision on overflow", () => {
    expect(() => mulInt(cents(Number.MAX_SAFE_INTEGER), 2)).toThrow(RangeError);
    expect(() => add(cents(Number.MAX_SAFE_INTEGER), cents(1))).toThrow(RangeError);
  });

  it("sums a list, empty list is zero", () => {
    expect(sum([])).toBe(0);
    expect(sum([cents(1), cents(2), cents(3)])).toBe(6);
  });
});

describe("demo quote", () => {
  it("$12 + $3 + $14 + $2 + $5 = $36 per box, $1,080 for 30", () => {
    const perBox = sum([cents(1200), cents(300), cents(1400), cents(200), cents(500)]);
    expect(perBox).toBe(3600);
    expect(mulInt(perBox, 30)).toBe(108000);
    expect(format(mulInt(perBox, 30))).toBe("$1,080.00");
  });
});

describe("roundHalfUp", () => {
  it("rounds a rational amount to whole cents, half away from zero", () => {
    // 10.5% of 1000 cents = 105 exactly
    expect(roundHalfUp(cents(1000), 105, 1000)).toBe(105);
    // 1 cent * 1/2 = 0.5 -> 1
    expect(roundHalfUp(cents(1), 1, 2)).toBe(1);
    // 1 cent * 1/3 = 0.33 -> 0
    expect(roundHalfUp(cents(1), 1, 3)).toBe(0);
    // 5 cents * 1/2 = 2.5 -> 3
    expect(roundHalfUp(cents(5), 1, 2)).toBe(3);
  });

  it("rounds negatives half away from zero", () => {
    expect(roundHalfUp(cents(-5), 1, 2)).toBe(-3);
  });

  it("rejects non-integer or non-positive denominators and non-integer numerators", () => {
    expect(() => roundHalfUp(cents(100), 1, 0)).toThrow(RangeError);
    expect(() => roundHalfUp(cents(100), 1, -2)).toThrow(RangeError);
    expect(() => roundHalfUp(cents(100), 0.5, 2)).toThrow(RangeError);
  });
});

describe("format (display only)", () => {
  it("formats USD with grouping and two decimals", () => {
    expect(format(cents(0))).toBe("$0.00");
    expect(format(cents(5))).toBe("$0.05");
    expect(format(cents(123456))).toBe("$1,234.56");
    expect(format(cents(-250))).toBe("-$2.50");
  });
});
