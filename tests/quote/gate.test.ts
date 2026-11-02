import { describe, expect, it } from "vitest";
import { gateForPublish } from "@/domain/quote/gate";
import type { Condition } from "@/domain/quote/types";

const slot: Condition = { code: "PRODUCTION_SLOT_CONFIRMATION", text: "Slot to be confirmed." };
const art: Condition = { code: "ARTWORK_ACCEPTANCE", text: "Artwork to be accepted." };
const unsupported: Condition = { code: "UNSUPPORTED_CUSTOMIZATION", text: "Embossed lid." };
const approved: Condition = { code: "MERCHANT_APPROVED_CUSTOMIZATION", text: "Merchant approves the embossed lid." };

describe("gateForPublish", () => {
  it("lets a quote with no conditions publish automatically", () => {
    expect(gateForPublish([])).toEqual({ canAutoPublish: true, mandatoryUnresolved: [] });
  });

  it("lets the two disclosable conditions through", () => {
    expect(gateForPublish([slot, art])).toEqual({ canAutoPublish: true, mandatoryUnresolved: [] });
  });

  it("holds an unresolved unsupported customization", () => {
    const g = gateForPublish([slot, unsupported]);
    expect(g.canAutoPublish).toBe(false);
    expect(g.mandatoryUnresolved).toEqual([unsupported]);
  });

  it("a merchant-approved customization is disclosed, not held", () => {
    expect(gateForPublish([approved, slot]).canAutoPublish).toBe(true);
  });

  it("an unsupported customization stays held even beside its approval", () => {
    // The merchant path replaces the condition; a quote carrying both is still not auto-publishable.
    expect(gateForPublish([unsupported, approved]).canAutoPublish).toBe(false);
  });

  it("does not mutate its input and keeps input order", () => {
    const input = [unsupported, art, { ...unsupported, text: "Second." }];
    const copy = structuredClone(input);
    const g = gateForPublish(input);
    expect(input).toEqual(copy);
    expect(g.mandatoryUnresolved.map((c) => c.text)).toEqual(["Embossed lid.", "Second."]);
  });
});
