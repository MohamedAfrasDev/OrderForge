import { describe, expect, it } from "vitest";
import { dollarsText, parseDollars, parseWholeNumber } from "@/domain/catalog-edit";

describe("parseDollars", () => {
  it("reads the ways a person types a price, as whole cents", () => {
    const cases: Array<[string, number]> = [["12", 1200], ["12.5", 1250], ["12.50", 1250], ["$12.50", 1250], ["$ 12.50", 1250], [" 12.05 ", 1205], ["0", 0], ["0.99", 99], ["1,200.00", 120000], ["1,234,567", 123456700], ["100000", 10000000]];
    for (const [text, minor] of cases) expect(parseDollars(text), text).toBe(minor);
  });
  it("never rounds or guesses: anything else is not a price", () => {
    for (const text of ["", " ", "abc", "12.505", "12.", ".5", "-5", "1e3", "12,5", "1,23", "12 50", "$$5", "5$", "NaN", "Infinity", "0x10", "12.5.0", "99999999999999999999"]) expect(parseDollars(text), text).toBeNull();
    for (const value of [null, undefined, 12, {}, []]) expect(parseDollars(value)).toBeNull();
  });
  it("round-trips with dollarsText", () => {
    for (const minor of [0, 1, 99, 100, 1250, 1300, 10_000_000]) expect(parseDollars(dollarsText(minor))).toBe(minor);
  });
});

describe("parseWholeNumber", () => {
  it("accepts whole numbers only", () => {
    expect(parseWholeNumber("40")).toBe(40);
    expect(parseWholeNumber(" 0 ")).toBe(0);
    expect(parseWholeNumber(7)).toBe(7);
    for (const bad of ["", "-1", "1.5", "1e3", "abc", "1,000", "9999999999", -1, 1.5, null, undefined]) expect(parseWholeNumber(bad), String(bad)).toBeNull();
  });
});
