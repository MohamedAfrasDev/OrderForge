import { describe, expect, it } from "vitest";
import {
  boxTemplateRuleSchema,
  configurationSchema,
  requirementsSchema,
} from "@/domain/catalog/schemas";
import type { Configuration, Requirements } from "@/domain/catalog/types";

const goodConfiguration = { boxCount: 20, selections: { notebook: "NB-01", pen: "PN-01" } };

describe("configurationSchema", () => {
  it("accepts boxCount and selections", () => {
    const parsed: Configuration = configurationSchema.parse(goodConfiguration);
    expect(parsed).toEqual(goodConfiguration);
  });

  it.each([
    ["unitPriceMinor", 100],
    ["discount", 0.5],
    ["total", 1],
    ["totalMinor", 1],
    ["amount", "charge $1"],
  ])("rejects an extra field %s", (field, value) => {
    expect(configurationSchema.safeParse({ ...goodConfiguration, [field]: value }).success).toBe(false);
  });

  it("rejects missing or wrongly typed fields", () => {
    expect(configurationSchema.safeParse({ selections: {} }).success).toBe(false);
    expect(configurationSchema.safeParse({ boxCount: "20", selections: {} }).success).toBe(false);
    expect(configurationSchema.safeParse({ boxCount: 20, selections: { pen: 5 } }).success).toBe(false);
    expect(configurationSchema.safeParse({ boxCount: 20 }).success).toBe(false);
  });

  it("leaves a bad box count to the validator so it can be reported as INVALID_QUANTITY", () => {
    expect(configurationSchema.safeParse({ boxCount: 0, selections: {} }).success).toBe(true);
    expect(configurationSchema.safeParse({ boxCount: 2.5, selections: {} }).success).toBe(true);
  });
});

describe("requirementsSchema", () => {
  const good = { noFood: true, logoRequired: true, maxPricePerBoxMinor: 3999, requestedPickupDate: "2026-12-01" };

  it("accepts the full shape and the optional fields left out", () => {
    const parsed: Requirements = requirementsSchema.parse(good);
    expect(parsed.maxPricePerBoxMinor).toBe(3999);
    expect(requirementsSchema.safeParse({ noFood: false, logoRequired: false }).success).toBe(true);
  });

  it("rejects extra fields", () => {
    expect(requirementsSchema.safeParse({ ...good, discount: 10 }).success).toBe(false);
  });

  it("rejects a budget that is not a non-negative integer number of cents", () => {
    for (const bad of [39.99, -1, "3999"]) {
      expect(requirementsSchema.safeParse({ ...good, maxPricePerBoxMinor: bad }).success).toBe(false);
    }
  });

  it.each(["2026-1-1", "01/12/2026", "2026-12-01T00:00:00Z", "2026-02-30", "2026-13-01", "2025-02-29", ""])(
    "rejects the pickup date %j",
    (date) => {
      expect(requirementsSchema.safeParse({ ...good, requestedPickupDate: date }).success).toBe(false);
    },
  );

  it("accepts a real leap day", () => {
    expect(requirementsSchema.safeParse({ ...good, requestedPickupDate: "2028-02-29" }).success).toBe(true);
  });
});

describe("boxTemplateRuleSchema", () => {
  const slot = (over: Record<string, unknown> = {}) => ({
    id: "gift",
    label: "Gift item",
    quantity: 1,
    allowedSkus: ["BOT-01", "ORG-01"],
    ...over,
  });
  const rule = (slots: unknown[]) => ({ slots });

  it("accepts a valid template with a logo slot", () => {
    const parsed = boxTemplateRuleSchema.parse(rule([slot(), slot({ id: "card", label: "Card", customization: "logo" })]));
    expect(parsed.slots).toHaveLength(2);
    expect(parsed.slots[1]?.customization).toBe("logo");
  });

  it("requires a non-empty slot list", () => {
    expect(boxTemplateRuleSchema.safeParse(rule([])).success).toBe(false);
    expect(boxTemplateRuleSchema.safeParse({}).success).toBe(false);
  });

  it("requires unique slot ids", () => {
    expect(boxTemplateRuleSchema.safeParse(rule([slot(), slot({ label: "Again" })])).success).toBe(false);
  });

  it.each([0, -1, 1.5, "1"])("rejects slot quantity %j", (quantity) => {
    expect(boxTemplateRuleSchema.safeParse(rule([slot({ quantity })])).success).toBe(false);
  });

  it("requires a non-empty, duplicate-free allowedSkus", () => {
    expect(boxTemplateRuleSchema.safeParse(rule([slot({ allowedSkus: [] })])).success).toBe(false);
    expect(boxTemplateRuleSchema.safeParse(rule([slot({ allowedSkus: ["A", "A"] })])).success).toBe(false);
    expect(boxTemplateRuleSchema.safeParse(rule([slot({ allowedSkus: [""] })])).success).toBe(false);
  });

  it("allows customization of exactly \"logo\" and nothing else", () => {
    expect(boxTemplateRuleSchema.safeParse(rule([slot({ customization: "logo" })])).success).toBe(true);
    expect(boxTemplateRuleSchema.safeParse(rule([slot({ customization: "engraving" })])).success).toBe(false);
  });

  it("rejects empty ids and labels, and unknown fields", () => {
    expect(boxTemplateRuleSchema.safeParse(rule([slot({ id: "" })])).success).toBe(false);
    expect(boxTemplateRuleSchema.safeParse(rule([slot({ label: "" })])).success).toBe(false);
    expect(boxTemplateRuleSchema.safeParse(rule([slot({ priceMinor: 100 })])).success).toBe(false);
    expect(boxTemplateRuleSchema.safeParse({ slots: [slot()], extra: 1 }).success).toBe(false);
  });
});
