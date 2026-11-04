import { describe, expect, it } from "vitest";
import { parseExtraction } from "@/domain/intake";

const ok = (raw: unknown) => {
  const r = parseExtraction(raw);
  if (!r.ok) throw new Error(`expected ok, got: ${r.errors.join("; ")}`);
  return r.value;
};
const bad = (raw: unknown): string[] => {
  const r = parseExtraction(raw);
  if (r.ok) throw new Error("expected a rejection");
  return r.errors;
};

describe("parseExtraction accepts the strict shape", () => {
  it("reads the demo message: 20 boxes, no food, logo, under $40, notebooks", () => {
    const e = ok({
      boxCount: { value: 20, status: "confirmed" },
      noFood: { value: true, status: "confirmed" },
      logoRequired: { value: true, status: "confirmed" },
      maxPricePerBoxMinor: { value: 4000, status: "confirmed" },
      preferences: { value: ["notebooks"], status: "confirmed" },
    });
    expect(e.boxCount).toEqual({ value: 20, status: "confirmed" });
    expect(e.maxPricePerBoxMinor).toEqual({ value: 4000, status: "confirmed" });
    expect(e.preferences?.value).toEqual(["notebooks"]);
    expect(e.requestedPickupDate).toBeUndefined();
  });

  it("an empty extraction (the message said nothing new) is fine", () => {
    expect(ok({})).toEqual({});
  });

  it("an unknown field has no value; a conflicted one may have either", () => {
    expect(ok({ maxPricePerBoxMinor: { value: null, status: "unknown" } }).maxPricePerBoxMinor).toEqual({ value: null, status: "unknown" });
    expect(ok({ maxPricePerBoxMinor: { value: null, status: "conflicted" } }).maxPricePerBoxMinor?.status).toBe("conflicted");
    expect(ok({ maxPricePerBoxMinor: { value: 6000, status: "conflicted" } }).maxPricePerBoxMinor?.value).toBe(6000);
  });

  it("a needs_confirmation field carries the value the model guessed", () => {
    expect(ok({ requestedPickupDate: { value: "2026-12-01", status: "needs_confirmation" } }).requestedPickupDate?.value).toBe("2026-12-01");
  });

  it("trims preferences", () => {
    expect(ok({ preferences: { value: ["  notebooks ", "pens"], status: "confirmed" } }).preferences?.value).toEqual(["notebooks", "pens"]);
  });
});

describe("parseExtraction rejects everything else, with reasons", () => {
  it("extra fields anywhere: an injected price, discount or total has nowhere to go", () => {
    expect(bad({ price: 1 }).join(" ")).toMatch(/price/);
    expect(bad({ totalMinor: 100 }).join(" ")).toMatch(/totalMinor/);
    expect(bad({ discountPercent: 90 }).join(" ")).toMatch(/discountPercent/);
    expect(bad({ boxCount: { value: 20, status: "confirmed", price: 1 } }).join(" ")).toMatch(/price/);
  });

  it("anything that is not an object", () => {
    for (const raw of [null, "20 boxes", 20, [], undefined]) expect(bad(raw).length).toBeGreaterThan(0);
  });

  it("unknown statuses", () => {
    expect(bad({ noFood: { value: true, status: "certain" } }).join(" ")).toMatch(/noFood/);
    expect(bad({ noFood: { value: true } }).join(" ")).toMatch(/noFood/);
  });

  it("a known status without a value", () => {
    expect(bad({ boxCount: { value: null, status: "confirmed" } }).join(" ")).toMatch(/boxCount.*value/i);
    expect(bad({ noFood: { value: null, status: "needs_confirmation" } }).join(" ")).toMatch(/noFood/);
  });

  it("an unknown field that still carries a value", () => {
    expect(bad({ boxCount: { value: 20, status: "unknown" } }).join(" ")).toMatch(/boxCount/);
  });

  it("box counts that are not positive whole numbers, including numbers sent as text", () => {
    for (const value of [0, -5, 2.5, "20", Number.NaN, Number.POSITIVE_INFINITY, 1_000_001]) {
      expect(bad({ boxCount: { value, status: "confirmed" } }).join(" "), String(value)).toMatch(/boxCount/);
    }
  });

  it("budgets that are not whole minor units (cents)", () => {
    for (const value of [0, -1, 3999.5, "4000", "$40", 1e12]) {
      expect(bad({ maxPricePerBoxMinor: { value, status: "confirmed" } }).join(" "), String(value)).toMatch(/maxPricePerBoxMinor/);
    }
  });

  it("booleans that are not booleans", () => {
    expect(bad({ noFood: { value: "yes", status: "confirmed" } }).join(" ")).toMatch(/noFood/);
    expect(bad({ logoRequired: { value: 1, status: "confirmed" } }).join(" ")).toMatch(/logoRequired/);
  });

  it("dates that are not real calendar days", () => {
    for (const value of ["2026-02-30", "2026-13-01", "next Friday", "12/01/2026", "2026-1-5", ""]) {
      expect(bad({ requestedPickupDate: { value, status: "confirmed" } }).join(" "), value).toMatch(/requestedPickupDate/);
    }
  });

  it("preferences that are too many, too long, empty or not text", () => {
    expect(bad({ preferences: { value: Array.from({ length: 11 }, (_, i) => `p${i}`), status: "confirmed" } }).join(" ")).toMatch(/preferences/);
    expect(bad({ preferences: { value: ["x".repeat(81)], status: "confirmed" } }).join(" ")).toMatch(/preferences/);
    expect(bad({ preferences: { value: ["   "], status: "confirmed" } }).join(" ")).toMatch(/preferences/);
    expect(bad({ preferences: { value: [5], status: "confirmed" } }).join(" ")).toMatch(/preferences/);
    expect(bad({ preferences: { value: "notebooks", status: "confirmed" } }).join(" ")).toMatch(/preferences/);
  });

  it("reports every problem at once, so one retry can fix them all", () => {
    const errors = bad({ boxCount: { value: 0, status: "confirmed" }, maxPricePerBoxMinor: { value: 1.5, status: "confirmed" }, nonsense: 1 });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it("does not change its input", () => {
    const raw = { boxCount: { value: 20, status: "confirmed" }, preferences: { value: [" a "], status: "confirmed" } };
    const before = JSON.stringify(raw);
    parseExtraction(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});
