import { describe, expect, it } from "vitest";
import {
  FIELD_STATUSES,
  blockingFields,
  confirmedBoxCount,
  emptyRequirements,
  mergeRequirements,
  parseExtraction,
  toCatalogRequirements,
  type Extraction,
  type FieldStatus,
  type RequirementsDoc,
} from "@/domain/intake";

const MSG1 = "11111111-1111-4111-8111-111111111111";
const MSG2 = "22222222-2222-4222-8222-222222222222";

const extraction = (raw: unknown): Extraction => {
  const r = parseExtraction(raw);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.value;
};

const demo = (): RequirementsDoc =>
  mergeRequirements(
    null,
    extraction({
      boxCount: { value: 20, status: "confirmed" },
      noFood: { value: true, status: "confirmed" },
      logoRequired: { value: true, status: "confirmed" },
      maxPricePerBoxMinor: { value: 4000, status: "confirmed" },
      preferences: { value: ["notebooks"], status: "confirmed" },
    }),
    MSG1,
  );

describe("mergeRequirements", () => {
  it("starts from nothing known", () => {
    const doc = emptyRequirements();
    for (const f of [doc.boxCount, doc.noFood, doc.logoRequired, doc.maxPricePerBoxMinor, doc.requestedPickupDate, doc.preferences]) {
      expect(f).toEqual({ value: null, status: "unknown", source: null });
    }
  });

  it("records each field with the message it came from; fields the message did not mention stay unknown", () => {
    const doc = demo();
    expect(doc.boxCount).toEqual({ value: 20, status: "confirmed", source: MSG1 });
    expect(doc.maxPricePerBoxMinor).toEqual({ value: 4000, status: "confirmed", source: MSG1 });
    expect(doc.requestedPickupDate).toEqual({ value: null, status: "unknown", source: null });
  });

  it("a later message updates what it addresses and keeps the rest", () => {
    const next = mergeRequirements(demo(), extraction({ boxCount: { value: 30, status: "confirmed" } }), MSG2);
    expect(next.boxCount).toEqual({ value: 30, status: "confirmed", source: MSG2 });
    expect(next.noFood).toEqual({ value: true, status: "confirmed", source: MSG1 });
    expect(next.maxPricePerBoxMinor.value).toBe(4000);
  });

  it("a message that says nothing about a field never erases it (unknown from the model keeps the old value)", () => {
    const next = mergeRequirements(demo(), extraction({ maxPricePerBoxMinor: { value: null, status: "unknown" } }), MSG2);
    expect(next.maxPricePerBoxMinor).toEqual({ value: 4000, status: "confirmed", source: MSG1 });
  });

  it("a customer edit outranks the model when they agree or the model says nothing", () => {
    const edited: RequirementsDoc = { ...demo(), boxCount: { value: 25, status: "confirmed", source: "customer_edit" } };
    const same = mergeRequirements(edited, extraction({ boxCount: { value: 25, status: "confirmed" } }), MSG2);
    expect(same.boxCount).toEqual({ value: 25, status: "confirmed", source: "customer_edit" });
    const silent = mergeRequirements(edited, extraction({ boxCount: { value: null, status: "unknown" } }), MSG2);
    expect(silent.boxCount).toEqual({ value: 25, status: "confirmed", source: "customer_edit" });
  });

  it("a later message that contradicts an edit makes the field conflicted, decided by code rather than by the model's status", () => {
    const edited: RequirementsDoc = { ...demo(), boxCount: { value: 25, status: "confirmed", source: "customer_edit" } };
    const next = mergeRequirements(edited, extraction({ boxCount: { value: 40, status: "confirmed" } }), MSG2);
    expect(next.boxCount.status).toBe("conflicted");
    expect(next.boxCount.value).toBe(40);
    expect(next.boxCount.source).toBe(MSG2);
  });

  it("the model's own doubt is kept: needs_confirmation and conflicted replace a confirmed value", () => {
    const next = mergeRequirements(demo(), extraction({ maxPricePerBoxMinor: { value: 6000, status: "conflicted" } }), MSG2);
    expect(next.maxPricePerBoxMinor).toEqual({ value: 6000, status: "conflicted", source: MSG2 });
  });

  it("preferences are replaced by the model's full list when it gives one", () => {
    const next = mergeRequirements(demo(), extraction({ preferences: { value: ["notebooks", "pens"], status: "confirmed" } }), MSG2);
    expect(next.preferences.value).toEqual(["notebooks", "pens"]);
  });

  it("returns a new document and never changes its inputs", () => {
    const previous = demo();
    const ex = extraction({ boxCount: { value: 30, status: "confirmed" } });
    const before = JSON.stringify([previous, ex]);
    const next = mergeRequirements(previous, ex, MSG2);
    expect(next).not.toBe(previous);
    expect(JSON.stringify([previous, ex])).toBe(before);
    next.preferences.value?.push("changed");
    expect(JSON.stringify(previous)).toBe(JSON.stringify(demo()));
  });
});

describe("blockingFields: code decides what blocks a quote", () => {
  const withField = (field: keyof RequirementsDoc, status: FieldStatus, value: unknown): RequirementsDoc => ({ ...demo(), [field]: { value, status, source: MSG1 } }) as RequirementsDoc;

  it("nothing blocks the demo request (step A)", () => {
    expect(blockingFields(demo())).toEqual([]);
  });

  it("an empty document blocks on the quantity alone", () => {
    expect(blockingFields(emptyRequirements())).toEqual(["boxCount"]);
  });

  it("the quantity blocks unless it is confirmed with a value", () => {
    for (const status of FIELD_STATUSES) {
      const blocked = blockingFields(withField("boxCount", status, status === "unknown" ? null : 20)).includes("boxCount");
      expect(blocked, status).toBe(status !== "confirmed");
    }
    expect(blockingFields(withField("boxCount", "confirmed", null))).toContain("boxCount");
  });

  for (const field of ["noFood", "logoRequired", "maxPricePerBoxMinor", "requestedPickupDate"] as const) {
    it(`${field}: conflicted and needs_confirmation block; unknown and confirmed do not`, () => {
      const value = field === "requestedPickupDate" ? "2026-12-01" : field === "maxPricePerBoxMinor" ? 4000 : true;
      expect(blockingFields(withField(field, "conflicted", value))).toEqual([field]);
      expect(blockingFields(withField(field, "needs_confirmation", value))).toEqual([field]);
      expect(blockingFields(withField(field, "unknown", null))).toEqual([]);
      expect(blockingFields(withField(field, "confirmed", value))).toEqual([]);
    });
  }

  it("preferences never block, whatever their status (they are soft)", () => {
    for (const status of FIELD_STATUSES) expect(blockingFields(withField("preferences", status, ["notebooks"]))).toEqual([]);
  });

  it("several blockers come back in a fixed order, so the first question is always the same one", () => {
    const doc: RequirementsDoc = {
      ...emptyRequirements(),
      maxPricePerBoxMinor: { value: 6000, status: "conflicted", source: MSG1 },
      noFood: { value: true, status: "needs_confirmation", source: MSG1 },
      requestedPickupDate: { value: "2026-12-01", status: "conflicted", source: MSG1 },
    };
    expect(blockingFields(doc)).toEqual(["boxCount", "noFood", "maxPricePerBoxMinor", "requestedPickupDate"]);
  });
});

describe("toCatalogRequirements: unknowns become not specified", () => {
  it("passes the confirmed values to the catalog engine", () => {
    const r = toCatalogRequirements(demo());
    expect(r).toEqual({ noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000 });
    expect(r.requestedPickupDate).toBeUndefined();
  });

  it("an empty document means no restriction, no logo, no budget, no date", () => {
    expect(toCatalogRequirements(emptyRequirements())).toEqual({ noFood: false, logoRequired: false });
  });

  it("only confirmed values count: a doubtful budget or date is not passed on", () => {
    const doc: RequirementsDoc = {
      ...demo(),
      maxPricePerBoxMinor: { value: 6000, status: "conflicted", source: MSG1 },
      requestedPickupDate: { value: "2026-12-01", status: "needs_confirmation", source: MSG1 },
    };
    const r = toCatalogRequirements(doc);
    expect(r.maxPricePerBoxMinor).toBeUndefined();
    expect(r.requestedPickupDate).toBeUndefined();
  });

  it("carries a confirmed date", () => {
    const doc: RequirementsDoc = { ...demo(), requestedPickupDate: { value: "2026-12-01", status: "confirmed", source: MSG1 } };
    expect(toCatalogRequirements(doc).requestedPickupDate).toBe("2026-12-01");
  });
});

describe("confirmedBoxCount", () => {
  it("is the quantity only when confirmed", () => {
    expect(confirmedBoxCount(demo())).toBe(20);
    expect(confirmedBoxCount(emptyRequirements())).toBeNull();
    expect(confirmedBoxCount({ ...demo(), boxCount: { value: 20, status: "needs_confirmation", source: MSG1 } })).toBeNull();
  });
});
