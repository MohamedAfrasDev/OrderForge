import { describe, expect, it } from "vitest";
import { conditionSchema, draftInputSchema } from "@/domain/quote/schemas";

const good = {
  inquiryId: "5b1f0f0e-6c0b-4f6e-9c58-0f3a3f1d2a11",
  configuration: { boxCount: 30, selections: { notebook: "NB-01", gift: "DO-01" } },
  requirements: { noFood: true, maxPricePerBoxMinor: 3999, logoRequired: true },
  requirementVersionId: "7d2c9a54-1c5e-4a7b-8e3f-2b6d4c8e9f10",
  conditions: [{ code: "PRODUCTION_SLOT_CONFIRMATION", text: "Production slot to be confirmed." }],
};

describe("draftInputSchema", () => {
  it("accepts a well-formed draft input", () => {
    const parsed = draftInputSchema.parse(good);
    expect(parsed.configuration.boxCount).toBe(30);
    expect(parsed.conditions).toHaveLength(1);
  });

  it("accepts a null requirementVersionId and no conditions", () => {
    expect(draftInputSchema.safeParse({ ...good, requirementVersionId: null, conditions: [] }).success).toBe(true);
  });

  it.each([
    ["total", 1],
    ["totalMinor", 1],
    ["amount", 100],
    ["discount", 0.5],
    ["unitPriceMinor", 1],
    ["status", "PUBLISHED"],
    ["quoteHash", "a".repeat(64)],
  ])("rejects an extra top-level field: %s", (key, value) => {
    expect(draftInputSchema.safeParse({ ...good, [key]: value }).success).toBe(false);
  });

  it("rejects a price smuggled into the configuration", () => {
    const bad = { ...good, configuration: { ...good.configuration, unitPriceMinor: 1 } };
    expect(draftInputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a malformed inquiry id", () => {
    expect(draftInputSchema.safeParse({ ...good, inquiryId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects an unknown condition code", () => {
    const bad = { ...good, conditions: [{ code: "FREE_SHIPPING", text: "x" }] };
    expect(draftInputSchema.safeParse(bad).success).toBe(false);
  });
});

describe("conditionSchema", () => {
  it("trims text and rejects empty or overlong text", () => {
    expect(conditionSchema.parse({ code: "ARTWORK_ACCEPTANCE", text: "  ok  " }).text).toBe("ok");
    expect(conditionSchema.safeParse({ code: "ARTWORK_ACCEPTANCE", text: "   " }).success).toBe(false);
    expect(conditionSchema.safeParse({ code: "ARTWORK_ACCEPTANCE", text: "x".repeat(501) }).success).toBe(false);
    expect(conditionSchema.safeParse({ code: "ARTWORK_ACCEPTANCE", text: "x".repeat(500) }).success).toBe(true);
  });

  it("rejects extra fields", () => {
    expect(conditionSchema.safeParse({ code: "ARTWORK_ACCEPTANCE", text: "x", fee: 1 }).success).toBe(false);
  });
});
