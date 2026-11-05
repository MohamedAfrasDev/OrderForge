import { describe, expect, it } from "vitest";
import { BLOCKING_FIELDS, emptyRequirements, parseAnswer, parseExtraction, quickRepliesFor, type BlockingField, type RequirementsDoc } from "@/domain/intake";
import { forbiddenIn } from "@/domain/journey";

const withField = (name: keyof RequirementsDoc, value: unknown, status: "confirmed" | "needs_confirmation" | "conflicted" = "needs_confirmation"): RequirementsDoc => ({
  ...emptyRequirements(),
  [name]: { value, status, source: "m1" },
});

describe("quickRepliesFor: the choices under an open question, decided by code", () => {
  it("offers a quantity number box with presets", () => {
    const q = quickRepliesFor({ field: "boxCount" }, emptyRequirements());
    expect(q.kind).toBe("number");
    expect(q.choices.map((c) => c.label)).toEqual(["10 boxes", "20 boxes", "50 boxes"]);
    expect(q.choices.map((c) => c.edit)).toEqual([{ boxCount: 10 }, { boxCount: 20 }, { boxCount: 50 }]);
  });

  it("puts the value the assistant guessed first, so one tap confirms it, without repeating a preset", () => {
    const guessed = quickRepliesFor({ field: "boxCount" }, withField("boxCount", 35));
    expect(guessed.choices[0]).toEqual({ label: "Yes, 35 boxes", edit: { boxCount: 35 } });
    expect(guessed.choices).toHaveLength(4);
    const preset = quickRepliesFor({ field: "boxCount" }, withField("boxCount", 20));
    expect(preset.choices.map((c) => c.label)).toEqual(["Yes, 20 boxes", "10 boxes", "50 boxes"]);
  });

  it("offers budgets in dollars a box, a way to say there is no limit, and the guessed value first", () => {
    const q = quickRepliesFor({ field: "maxPricePerBoxMinor" }, withField("maxPricePerBoxMinor", 5500, "conflicted"));
    expect(q.kind).toBe("money");
    expect(q.choices.map((c) => c.label)).toEqual(["Yes, up to $55.00 a box", "Up to $25.00 a box", "Up to $40.00 a box", "Up to $60.00 a box", "No limit"]);
    expect(q.choices.at(-1)!.edit).toEqual({ maxPricePerBoxMinor: null });
    expect(q.choices[2]!.edit).toEqual({ maxPricePerBoxMinor: 4000 });
  });

  it("offers yes and no for food and for the logo", () => {
    expect(quickRepliesFor({ field: "noFood" }, emptyRequirements())).toEqual({
      field: "noFood",
      kind: "choice",
      choices: [
        { label: "Yes, no food", edit: { noFood: true } },
        { label: "Food is fine", edit: { noFood: false } },
      ],
    });
    expect(quickRepliesFor({ field: "logoRequired" }, emptyRequirements()).choices).toEqual([
      { label: "Yes, add our logo", edit: { logoRequired: true } },
      { label: "No logo needed", edit: { logoRequired: false } },
    ]);
  });

  it("offers any day and a date for the pickup date, with the guessed date first", () => {
    const q = quickRepliesFor({ field: "requestedPickupDate" }, withField("requestedPickupDate", "2026-12-01"));
    expect(q.kind).toBe("date");
    expect(q.choices).toEqual([
      { label: "Yes, 2026-12-01", edit: { requestedPickupDate: "2026-12-01" } },
      { label: "Any day", edit: { requestedPickupDate: null } },
    ]);
  });

  it("covers every blocking field, and only offers what the strict edit rules accept", () => {
    for (const field of BLOCKING_FIELDS satisfies readonly BlockingField[]) {
      const q = quickRepliesFor({ field }, emptyRequirements());
      expect(q.field).toBe(field);
      expect(q.choices.length, field).toBeGreaterThan(0);
      for (const c of q.choices) {
        const keys = Object.keys(c.edit);
        expect(keys, `${field}: ${c.label}`).toEqual([field]);
        const value = c.edit[field];
        if (value !== null) expect(parseExtraction({ [field]: { value, status: "confirmed" } }).ok, `${field}: ${c.label}`).toBe(true);
      }
    }
  });

  it("uses only customer words in every label", () => {
    for (const field of BLOCKING_FIELDS) {
      for (const c of quickRepliesFor({ field }, withField(field, field === "noFood" || field === "logoRequired" ? true : field === "requestedPickupDate" ? "2026-12-01" : 30)).choices) {
        expect(forbiddenIn(c.label), c.label).toEqual([]);
      }
    }
  });

  it("does not change what it was given", () => {
    const doc = withField("boxCount", 35);
    const copy = JSON.parse(JSON.stringify(doc));
    quickRepliesFor({ field: "boxCount" }, doc);
    expect(doc).toEqual(copy);
  });
});

describe("parseAnswer: what the customer typed into a line or the question box", () => {
  it("reads a quantity", () => {
    expect(parseAnswer("boxCount", "25")).toEqual({ ok: true, value: 25 });
    expect(parseAnswer("boxCount", " 25 ")).toEqual({ ok: true, value: 25 });
    expect(parseAnswer("boxCount", "")).toEqual({ ok: true, value: null });
    for (const bad of ["0", "-3", "2.5", "twenty", "1,000", "99999999", "20 boxes"]) expect(parseAnswer("boxCount", bad), bad).toEqual({ ok: false });
  });

  it("reads a budget in dollars into whole cents", () => {
    expect(parseAnswer("maxPricePerBoxMinor", "40")).toEqual({ ok: true, value: 4000 });
    expect(parseAnswer("maxPricePerBoxMinor", "$40.50")).toEqual({ ok: true, value: 4050 });
    expect(parseAnswer("maxPricePerBoxMinor", "12.5")).toEqual({ ok: true, value: 1250 });
    expect(parseAnswer("maxPricePerBoxMinor", "")).toEqual({ ok: true, value: null });
    for (const bad of ["0", "0.00", "-5", "12.345", "forty", "1e3", "9999999"]) expect(parseAnswer("maxPricePerBoxMinor", bad), bad).toEqual({ ok: false });
  });

  it("reads yes, no and nothing for food and the logo", () => {
    expect(parseAnswer("noFood", "yes")).toEqual({ ok: true, value: true });
    expect(parseAnswer("logoRequired", "no")).toEqual({ ok: true, value: false });
    expect(parseAnswer("noFood", "")).toEqual({ ok: true, value: null });
    expect(parseAnswer("noFood", "maybe")).toEqual({ ok: false });
  });

  it("reads a date and a list of preferences", () => {
    expect(parseAnswer("requestedPickupDate", "2026-12-01")).toEqual({ ok: true, value: "2026-12-01" });
    expect(parseAnswer("requestedPickupDate", "")).toEqual({ ok: true, value: null });
    expect(parseAnswer("requestedPickupDate", "next week")).toEqual({ ok: false });
    expect(parseAnswer("preferences", "notebooks, pens ,")).toEqual({ ok: true, value: ["notebooks", "pens"] });
    expect(parseAnswer("preferences", " , ")).toEqual({ ok: true, value: null });
    expect(parseAnswer("preferences", Array.from({ length: 11 }, (_, i) => `p${i}`).join(","))).toEqual({ ok: false });
    expect(parseAnswer("preferences", "x".repeat(81))).toEqual({ ok: false });
  });
});
