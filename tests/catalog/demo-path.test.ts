import { describe, expect, it } from "vitest";
import { validateConfiguration } from "@/domain/catalog/validate";
import { demoInput, withGift } from "./fixtures";

// Brief steps 3 and 4. Step C (alternatives) is covered in alternatives.test.ts.
describe("demo path", () => {
  it("A: 20 boxes with the bottle is valid at 3500 per box and 70000 in total", () => {
    const r = validateConfiguration(demoInput({ configuration: { boxCount: 20, selections: withGift("BOT-01") } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.priced.perBoxMinor).toBe(3500);
    expect(r.priced.totalMinor).toBe(70000);
    expect(r.priced.lines.map((l) => l.unitPriceMinor)).toEqual([1200, 300, 1300, 200, 500]);
  });

  it("B: the same box raised to 30 is blocked by stock (bottle, need 30, have 24)", () => {
    const r = validateConfiguration(demoInput({ configuration: { boxCount: 30, selections: withGift("BOT-01") } }));
    expect(r).toEqual({
      ok: false,
      blockers: [{ code: "INSUFFICIENT_STOCK", sku: "BOT-01", needed: 30, available: 24 }],
    });
  });

  it("D: 30 boxes with the organizer is valid at 3600 per box and 108000 in total", () => {
    const r = validateConfiguration(demoInput({ configuration: { boxCount: 30, selections: withGift("ORG-01") } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.priced.perBoxMinor).toBe(3600);
    expect(r.priced.totalMinor).toBe(108000);
  });

  it("the truffles are blocked under no-food", () => {
    const r = validateConfiguration(demoInput({ configuration: { boxCount: 10, selections: withGift("TRF-01") } }));
    expect(r).toEqual({ ok: false, blockers: [{ code: "FOOD_NOT_ALLOWED", slotId: "gift", sku: "TRF-01" }] });
  });
});
