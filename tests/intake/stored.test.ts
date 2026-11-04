import { describe, expect, it } from "vitest";
import { STORED_REQUIREMENTS_TAG, emptyRequirements, emptyStored, storedRequirementsSchema, type StoredRequirements } from "@/domain/intake";

const sample = (): StoredRequirements => ({
  ...emptyStored(),
  fields: { ...emptyRequirements(), boxCount: { value: 20, status: "confirmed", source: "customer_edit" } },
});

describe("the stored requirements document", () => {
  it("starts with nothing known, no proposal and no open question", () => {
    const s = emptyStored();
    expect(s.schema).toBe(STORED_REQUIREMENTS_TAG);
    expect(s.proposal).toBeNull();
    expect(s.question).toBeNull();
    expect(s.fields).toEqual(emptyRequirements());
  });

  it("round-trips through JSON", () => {
    const s = sample();
    expect(storedRequirementsSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("accepts a proposal with code-priced alternatives and an open question", () => {
    const s: StoredRequirements = {
      ...sample(),
      question: { field: "noFood", text: "Should the boxes be free of any food items?" },
      proposal: {
        selections: { notebook: "NOTEBOOK-A5" },
        status: "BLOCKED",
        blockers: ["INSUFFICIENT_STOCK"],
        priced: null,
        alternatives: [{ key: "alt-0", slotId: "gift", fromSku: "BOTTLE-STEEL", toSku: "ORGANIZER-DESK", perBoxMinor: 3600, totalMinor: 108000, explanation: "Keeps the price." }],
      },
    };
    expect(storedRequirementsSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("is strict: an unknown key, a wrong tag or a bad status is refused", () => {
    expect(storedRequirementsSchema.safeParse({ ...sample(), extra: 1 }).success).toBe(false);
    expect(storedRequirementsSchema.safeParse({ ...sample(), schema: "other" }).success).toBe(false);
    const bad = sample();
    (bad.fields.boxCount as { status: string }).status = "certain";
    expect(storedRequirementsSchema.safeParse(bad).success).toBe(false);
    expect(storedRequirementsSchema.safeParse({ ...sample(), question: { field: "price", text: "x" } }).success).toBe(false);
  });
});
