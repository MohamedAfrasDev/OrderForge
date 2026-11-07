// Where each fact on the order screen came from, in the customer's words. Pure mapping from what the system already knows.
import { describe, expect, it } from "vitest";
import { PROVENANCE, PROVENANCE_LABELS, forbiddenIn, provenanceOfField, provenanceOfFigure } from "@/domain/journey";
import { claimsIn } from "@/lib/claims";

type F = Parameters<typeof provenanceOfField>[0];
const field = (over: Partial<F> = {}): F => ({ value: 20, status: "confirmed", source: "message", ...over });

describe("the three labels", () => {
  it("are exactly the three the screens use, with a one-sentence meaning each", () => {
    expect(PROVENANCE).toEqual(["message", "confirmed", "calculated"]);
    expect(PROVENANCE_LABELS.message.label).toBe("From your message");
    expect(PROVENANCE_LABELS.confirmed.label).toBe("You confirmed");
    expect(PROVENANCE_LABELS.calculated.label).toBe("Calculated by us");
    for (const key of PROVENANCE) expect(PROVENANCE_LABELS[key].detail).toMatch(/^[A-Z].*\.$/);
  });

  it("are different, plain words (the meaning is in the text, never in a colour)", () => {
    const labels = PROVENANCE.map((k) => PROVENANCE_LABELS[k].label);
    expect(new Set(labels).size).toBe(3);
    for (const k of PROVENANCE) {
      const { label, detail } = PROVENANCE_LABELS[k];
      expect(label).not.toMatch(/[.!]$/); // a label, not a sentence
      expect(forbiddenIn(`${label} ${detail}`), k).toEqual([]);
      expect(claimsIn(`${label} ${detail}`), k).toEqual([]);
    }
  });

  it("say who did the work: the assistant read it, the customer set it, or code worked it out (and the assistant did not)", () => {
    expect(PROVENANCE_LABELS.message.detail).toMatch(/assistant read/i);
    expect(PROVENANCE_LABELS.confirmed.detail).toMatch(/you/i);
    expect(PROVENANCE_LABELS.calculated.detail).toMatch(/prices and stock/i);
    expect(PROVENANCE_LABELS.calculated.detail).toMatch(/not (by )?the assistant/i);
  });
});

describe("provenanceOfField", () => {
  it("a fact the assistant read from a message and the system is sure of is 'From your message'", () => {
    expect(provenanceOfField(field())).toBe("message");
  });

  it("a fact the customer set or answered themselves is 'You confirmed'", () => {
    expect(provenanceOfField(field({ source: "edit" }))).toBe("confirmed");
    expect(provenanceOfField(field({ source: "edit", value: false }))).toBe("confirmed");
  });

  it("a value of false is still a value (it has a source)", () => {
    expect(provenanceOfField(field({ value: false }))).toBe("message");
  });

  it("nothing is claimed for a fact nobody gave: no value, or not specified", () => {
    for (const value of [null, undefined, []]) expect(provenanceOfField(field({ value })), String(value)).toBeNull();
    expect(provenanceOfField(field({ status: "unknown", source: null, value: null }))).toBeNull();
  });

  it("nothing is claimed while the system is unsure: those lines ask a question instead", () => {
    expect(provenanceOfField(field({ status: "needs_confirmation" }))).toBeNull();
    expect(provenanceOfField(field({ status: "conflicted" }))).toBeNull();
    expect(provenanceOfField(field({ status: "needs_confirmation", source: "edit" }))).toBeNull();
  });

  it("a fact with no source is never credited to the customer or the message", () => {
    expect(provenanceOfField(field({ source: null }))).toBeNull();
  });
});

describe("provenanceOfFigure", () => {
  it("every price, total and item the shop's catalog produced is 'Calculated by us'", () => {
    expect(provenanceOfFigure()).toBe("calculated");
  });
});
