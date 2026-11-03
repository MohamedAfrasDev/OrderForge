import { describe, expect, it } from "vitest";
import { WORKSHEET_SCHEMA_TAG, buildWorksheet, customerStatusOf, worksheetSchema, type WorksheetFacts } from "@/domain/fulfillment";
import type { QuoteSnapshot } from "@/domain/quote";
import { cents } from "@/lib/money";

const snapshot = (over: Record<string, unknown> = {}) =>
  ({
    schema: "orderforge.quote.v1" as const,
    merchantId: "00000000-0000-4000-8000-000000000001",
    inquiryId: "11111111-1111-4111-8111-111111111111",
    version: 2,
    requirementVersionId: null,
    boxCount: 30,
    perBoxMinor: cents(3600),
    totalMinor: cents(108000),
    currency: "USD" as const,
    lines: [
      { slotId: "notebook", sku: "NOTEBOOK-A5", name: "A5 notebook", unitPriceMinor: cents(900), quantity: 1 },
      { slotId: "pen", sku: "PEN-BLK", name: "Black pen", unitPriceMinor: cents(300), quantity: 1 },
      { slotId: "gift", sku: "ORGANIZER-DESK", name: "Desk organizer", unitPriceMinor: cents(1500), quantity: 1 },
      { slotId: "card", sku: "CARD-BRANDED", name: "Branded card", unitPriceMinor: cents(200), quantity: 1 },
      { slotId: "packaging", sku: "PACK-BOX", name: "Gift box", unitPriceMinor: cents(700), quantity: 1 },
    ],
    conditions: [
      { code: "PRODUCTION_SLOT_CONFIRMATION" as const, text: "Production slot to be confirmed." },
      { code: "ARTWORK_ACCEPTANCE" as const, text: "Artwork to be accepted." },
    ],
    ...over,
  }) as unknown as QuoteSnapshot;

const facts = (over: Partial<WorksheetFacts> = {}): WorksheetFacts => ({
  purchaseId: "22222222-2222-4222-8222-222222222222",
  quoteHash: "a".repeat(64),
  fulfilmentMethod: "customer_pickup",
  productionLeadDays: 7,
  createdAt: "2026-11-03T10:30:00.000Z",
  confirmedConditions: ["PRODUCTION_SLOT_CONFIRMATION"],
  ...over,
});

describe("buildWorksheet", () => {
  it("copies what was accepted: quote reference, boxes, lines per box and the total paid", () => {
    const w = buildWorksheet(snapshot(), facts());
    expect(w.schema).toBe(WORKSHEET_SCHEMA_TAG);
    expect(w.quote).toEqual({ version: 2, hash: "a".repeat(64) });
    expect(w.purchaseId).toBe("22222222-2222-4222-8222-222222222222");
    expect(w.inquiryId).toBe("11111111-1111-4111-8111-111111111111");
    expect(w.boxCount).toBe(30);
    expect(w.perBox).toHaveLength(5);
    expect(w.perBox[0]).toEqual({ slotId: "notebook", sku: "NOTEBOOK-A5", name: "A5 notebook", quantityPerBox: 1 });
    expect(w.paid).toEqual({ totalMinor: 108000, currency: "USD" });
  });

  it("lists what to pick: quantity per box times boxes, summed per SKU, in SKU order", () => {
    const w = buildWorksheet(snapshot(), facts());
    expect(w.pick.map((p) => [p.sku, p.quantity])).toEqual([
      ["CARD-BRANDED", 30],
      ["NOTEBOOK-A5", 30],
      ["ORGANIZER-DESK", 30],
      ["PACK-BOX", 30],
      ["PEN-BLK", 30],
    ]);
  });

  it("counts a product that sits in two slots twice", () => {
    const lines = [
      { slotId: "a", sku: "PEN-BLK", name: "Black pen", unitPriceMinor: cents(300), quantity: 1 },
      { slotId: "b", sku: "PEN-BLK", name: "Black pen", unitPriceMinor: cents(300), quantity: 2 },
    ];
    const w = buildWorksheet(snapshot({ boxCount: 10, lines }), facts());
    expect(w.pick).toEqual([{ sku: "PEN-BLK", name: "Black pen", quantity: 30 }]);
    expect(w.perBox).toHaveLength(2);
  });

  it("marks which conditions the merchant confirmed", () => {
    const w = buildWorksheet(snapshot(), facts());
    expect(w.conditions).toEqual([
      { code: "PRODUCTION_SLOT_CONFIRMATION", text: "Production slot to be confirmed.", confirmed: true },
      { code: "ARTWORK_ACCEPTANCE", text: "Artwork to be accepted.", confirmed: false },
    ]);
    expect(buildWorksheet(snapshot(), facts({ confirmedConditions: [] })).conditions.every((c) => !c.confirmed)).toBe(true);
  });

  it("ignores a confirmed code the quote never carried", () => {
    const w = buildWorksheet(snapshot({ conditions: [] }), facts({ confirmedConditions: ["ARTWORK_ACCEPTANCE"] }));
    expect(w.conditions).toEqual([]);
  });

  it("sets ready-by to the creation day plus the lead days, in UTC, and records both", () => {
    expect(buildWorksheet(snapshot(), facts()).readyBy).toBe("2026-11-10");
    expect(buildWorksheet(snapshot(), facts({ createdAt: "2026-11-30T23:59:59.000Z", productionLeadDays: 2 })).readyBy).toBe("2026-12-02");
    expect(buildWorksheet(snapshot(), facts({ createdAt: "2026-12-30T12:00:00.000Z", productionLeadDays: 7 })).readyBy).toBe("2027-01-06");
    const w = buildWorksheet(snapshot(), facts({ productionLeadDays: 0 }));
    expect(w.productionLeadDays).toBe(0);
    expect(w.readyBy).toBe("2026-11-03");
    expect(w.fulfilment).toEqual({ method: "customer_pickup" });
  });

  it("is deterministic and does not change its inputs", () => {
    const s = snapshot();
    const f = facts();
    const before = JSON.stringify([s, f]);
    expect(JSON.stringify(buildWorksheet(s, f))).toBe(JSON.stringify(buildWorksheet(s, f)));
    expect(JSON.stringify([s, f])).toBe(before);
  });

  it("holds no payer, contact or PayPal data", () => {
    const text = JSON.stringify(buildWorksheet(snapshot(), facts()));
    expect(text).not.toMatch(/payer|email|phone|address|paypal|authoriz|capture|order_id/i);
  });

  it("round-trips through its own schema", () => {
    const w = buildWorksheet(snapshot(), facts());
    expect(worksheetSchema.parse(JSON.parse(JSON.stringify(w)))).toEqual(w);
    expect(() => worksheetSchema.parse({ ...w, extra: 1 })).toThrow();
    expect(() => worksheetSchema.parse({ ...w, schema: "other" })).toThrow();
  });

  it("refuses a malformed snapshot or malformed facts", () => {
    expect(() => buildWorksheet(snapshot({ boxCount: 0 }), facts())).toThrow(RangeError);
    expect(() => buildWorksheet(snapshot({ boxCount: 1.5 }), facts())).toThrow(RangeError);
    expect(() => buildWorksheet(snapshot({ lines: [] }), facts())).toThrow(RangeError);
    expect(() => buildWorksheet(snapshot(), facts({ productionLeadDays: -1 }))).toThrow(RangeError);
    expect(() => buildWorksheet(snapshot(), facts({ productionLeadDays: 366 }))).toThrow(RangeError);
    expect(() => buildWorksheet(snapshot(), facts({ productionLeadDays: 1.5 }))).toThrow(RangeError);
    expect(() => buildWorksheet(snapshot(), facts({ createdAt: "not a date" }))).toThrow(RangeError);
    expect(() => buildWorksheet(snapshot(), facts({ quoteHash: "xyz" }))).toThrow(RangeError);
    expect(() => buildWorksheet(snapshot({ lines: [{ slotId: "a", sku: "X", name: "x", unitPriceMinor: cents(1), quantity: 0 }] }), facts())).toThrow(RangeError);
  });
});

describe("customerStatusOf", () => {
  it("collapses the five statuses to the four words a customer sees", () => {
    expect(customerStatusOf("QUEUED")).toBe("PREPARING");
    expect(customerStatusOf("PREPARING")).toBe("PREPARING");
    expect(customerStatusOf("READY_FOR_PICKUP")).toBe("READY");
    expect(customerStatusOf("COLLECTED")).toBe("COLLECTED");
    expect(customerStatusOf("ON_HOLD")).toBe("DELAYED");
  });
});
