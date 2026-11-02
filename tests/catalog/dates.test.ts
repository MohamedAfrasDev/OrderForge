import { describe, expect, it } from "vitest";
import { addDays, isCalendarDate } from "@/domain/catalog/dates";

describe("isCalendarDate", () => {
  it.each(["2026-11-02", "2028-02-29", "2026-12-31"])("accepts %s", (d) => expect(isCalendarDate(d)).toBe(true));
  it.each(["2025-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2026-1-1", "", "2026-11-02T00:00"])(
    "rejects %j",
    (d) => expect(isCalendarDate(d)).toBe(false),
  );
});

describe("addDays", () => {
  it.each([
    ["2026-11-02", 0, "2026-11-02"],
    ["2026-11-02", 5, "2026-11-07"],
    ["2026-01-30", 2, "2026-02-01"],
    ["2026-02-27", 2, "2026-03-01"],
    ["2028-02-27", 2, "2028-02-29"],
    ["2028-02-28", 2, "2028-03-01"],
    ["2026-12-30", 2, "2027-01-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-11-02", 365, "2027-11-02"],
  ])("%s + %i = %s", (date, n, expected) => expect(addDays(date, n)).toBe(expected));

  it("throws on a bad date or a non-integer or negative day count", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
    expect(() => addDays("2026-11-02", 1.5)).toThrow(RangeError);
    expect(() => addDays("2026-11-02", -1)).toThrow(RangeError);
  });
});
