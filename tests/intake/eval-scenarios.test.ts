// The evaluation set is well formed, the scorer tells a miss (the model's result) from a violation (a pipeline bug), and the report
// claims no rate, score or speed. The real-model run itself is manual (`npm run eval:intake`); the replay is in tests/db.
import { describe, expect, it } from "vitest";
import { cents } from "@/lib/money";
import type { Catalog } from "@/domain/catalog";
import { FIELD_NAMES, type FieldName } from "@/domain/intake";
import { GATE_SCENARIOS, renderReport, summarize, type ModelRun } from "../../eval/intake/report";
import { SCENARIOS } from "../../eval/intake/scenarios";
import { invariantViolations, judgeTurn, outcomeMisses, type Observed } from "../../eval/intake/score";
import type { ScenarioRun } from "../../eval/intake/harness";
import { boxTemplate, products } from "../../supabase/seed/fixtures";

const catalog: Catalog = {
  products: products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, category: p.category, unitPriceMinor: cents(p.unit_price_minor), isFood: p.is_food, active: true })),
  slots: boxTemplate.slots as Catalog["slots"],
  rules: { productionLeadDays: 7 },
};

const unknown = { value: null, status: "unknown" as const };
const blankFields = () => Object.fromEntries(FIELD_NAMES.map((n) => [n, { ...unknown }])) as Observed["fields"];

function proposed(over: Partial<Observed> = {}): Observed {
  return {
    outcome: "PROPOSED",
    fields: { ...blankFields(), boxCount: { value: 20, status: "confirmed" } as Observed["fields"]["boxCount"] },
    proposal: {
      selections: { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "BOTTLE-STEEL", card: "CARD-BRANDED", packaging: "PACK-BOX" },
      status: "VALID",
      blockers: [],
      priced: { perBoxMinor: 3500, totalMinor: 70_000, boxCount: 20 },
      alternatives: [],
    },
    reply: "Here is a box that fits. It comes to $35.00 per box, $700.00 for 20 boxes.",
    inquiryStatus: "CONFIGURING",
    ...over,
  };
}

describe("the scenario set", () => {
  it("has at least 15 scenarios with unique ids and every category the spec lists", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(15);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    const text = SCENARIOS.map((s) => `${s.category} ${s.title}`.toLowerCase()).join(" | ");
    for (const topic of ["missing quantity", "missing budget", "budget stated two ways", "ambiguous packaging", "food exclusion", "unsupported date", "quantity change breaks stock", "something not sold", "hostile message", "very long message", "second language", "correction mid-conversation"]) {
      expect(text, topic).toContain(topic);
    }
  });

  it("is well formed: messages the app would accept, and an outcome that says what it needs to", () => {
    for (const s of SCENARIOS) {
      expect(s.turns.length, s.id).toBeGreaterThan(0);
      for (const [i, t] of s.turns.entries()) {
        const where = `${s.id} turn ${i + 1}`;
        expect(t.say.trim().length, where).toBeGreaterThan(0);
        expect(t.say.length, where).toBeLessThanOrEqual(4000);
        expect(t.say, where).not.toContain("\u0000");
        if (t.expect.outcome === "ASKED") expect(t.expect.askedField, where).toBeDefined();
        if (t.expect.proposal || t.expect.selections || t.expect.perBoxMinor !== undefined || t.expect.blockersInclude || t.expect.alternativesInclude) expect(t.expect.outcome, where).toBe("PROPOSED");
        if (t.expect.blockersInclude || t.expect.alternativesInclude) expect(t.expect.proposal, where).toBe("BLOCKED");
        if (t.expect.perBoxMinor !== undefined) expect(t.expect.proposal, where).toBe("VALID");
        for (const name of Object.keys(t.expect.values ?? {})) expect(FIELD_NAMES as readonly string[], where).toContain(name);
        for (const [slot, sku] of Object.entries(t.expect.selections ?? {})) {
          expect(catalog.slots.find((x) => x.id === slot)?.allowedSkus, `${where} ${slot}`).toContain(sku);
        }
      }
    }
  });

  it("covers the long message at close to the limit and every scenario named by the gate", () => {
    expect(Math.max(...SCENARIOS.flatMap((s) => s.turns.map((t) => t.say.length)))).toBeGreaterThan(3500);
    for (const id of GATE_SCENARIOS) expect(SCENARIOS.map((s) => s.id), id).toContain(id);
  });

  it("states the expected figures exactly as the catalog engine computes them", () => {
    const breaks = SCENARIOS.find((s) => s.id === "quantity-breaks-stock")!;
    expect(breaks.turns[0]!.expect.perBoxMinor).toBe(12_00 + 3_00 + 13_00 + 2_00 + 5_00);
  });
});

describe("the scorer", () => {
  it("accepts a sound turn", () => {
    expect(invariantViolations(proposed(), catalog)).toEqual([]);
    expect(outcomeMisses({ outcome: "PROPOSED", proposal: "VALID", perBoxMinor: 3500, values: { boxCount: 20 }, selections: { gift: "BOTTLE-STEEL" } }, proposed())).toEqual([]);
  });

  it("calls a wrong outcome a miss, and stops there", () => {
    const asked = proposed({ outcome: "ASKED", askedField: "boxCount", proposal: null });
    expect(outcomeMisses({ outcome: "PROPOSED", proposal: "VALID" }, asked)).toEqual(["expected PROPOSED, got ASKED"]);
    expect(outcomeMisses({ outcome: "ASKED", askedField: "maxPricePerBoxMinor" }, asked)).toEqual(["asked about boxCount, expected maxPricePerBoxMinor"]);
    expect(outcomeMisses({ outcome: "PROPOSED" }, { ...proposed(), outcome: "FAILED", code: "MODEL_UNAVAILABLE" })).toEqual(["expected PROPOSED, got FAILED (MODEL_UNAVAILABLE)"]);
  });

  it("lists every difference in a proposal and in the values read", () => {
    const misses = outcomeMisses(
      { outcome: "PROPOSED", proposal: "BLOCKED", blockersInclude: ["INSUFFICIENT_STOCK"], alternativesInclude: ["ORGANIZER-DESK"], perBoxMinor: 3600, selections: { gift: "ORGANIZER-DESK" }, values: { boxCount: 30, noFood: true }, notConfirmed: ["boxCount"] },
      proposed(),
    );
    expect(misses.length).toBeGreaterThanOrEqual(7);
    expect(misses.join("\n")).toMatch(/proposal was VALID, expected BLOCKED/);
    expect(misses.join("\n")).toMatch(/noFood was null \(unknown\)/);
    expect(misses.join("\n")).toMatch(/boxCount was confirmed, expected it to stay open/);
  });

  it("a value that is not confirmed does not satisfy an expected value", () => {
    const o = proposed({ fields: { ...blankFields(), boxCount: { value: 20, status: "needs_confirmation" } as Observed["fields"]["boxCount"] } });
    expect(outcomeMisses({ outcome: "PROPOSED", values: { boxCount: 20 } }, o)).toHaveLength(1);
  });

  it("calls a wrong price, an invented product, a stray amount or a ready quote a violation", () => {
    const wrongPrice = proposed();
    wrongPrice.proposal!.priced = { perBoxMinor: 100, totalMinor: 2000, boxCount: 20 };
    expect(invariantViolations(wrongPrice, catalog).join()).toMatch(/price shown differs/);

    const invented = proposed();
    invented.proposal!.selections.gift = "FREE-GIFT";
    expect(invariantViolations(invented, catalog).join()).toMatch(/does not exist/);

    const disallowed = proposed();
    disallowed.proposal!.selections.gift = "PEN-BLK";
    expect(invariantViolations(disallowed, catalog).join()).toMatch(/does not allow/);

    expect(invariantViolations(proposed({ reply: "Now only $1.00 per box! It comes to $35.00 per box." }), catalog).join()).toMatch(/amount code did not produce: 100 cents/);
    expect(invariantViolations(proposed({ inquiryStatus: "QUOTE_READY" }), catalog)).toContain("a turn left a quote ready");
  });

  it("checks an alternative's price against the engine too", () => {
    const o = proposed();
    o.proposal = {
      selections: { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "BOTTLE-STEEL", card: "CARD-BRANDED", packaging: "PACK-BOX" },
      status: "BLOCKED",
      blockers: ["INSUFFICIENT_STOCK"],
      priced: null,
      alternatives: [{ key: "alt-0", slotId: "gift", fromSku: "BOTTLE-STEEL", toSku: "ORGANIZER-DESK", perBoxMinor: 3600, totalMinor: 108_000, explanation: null }],
    };
    o.fields.boxCount = { value: 30, status: "confirmed" };
    o.reply = "These options do work: $36.00 per box, $1,080.00 in total";
    expect(invariantViolations(o, catalog)).toEqual([]);
    o.proposal.alternatives[0]!.totalMinor = 100_000;
    expect(invariantViolations(o, catalog).join()).toMatch(/alternative's price differs/);
  });

  it("judgeTurn keeps the two apart", () => {
    const v = judgeTurn({ outcome: "ASKED", askedField: "boxCount" }, proposed(), catalog);
    expect(v.misses).toHaveLength(1);
    expect(v.violations).toEqual([]);
  });
});

function runOf(id: string, miss: string[], violation: string[], model = "m1", outcome: Observed["outcome"] = "PROPOSED"): ScenarioRun {
  return { id, turns: [{ say: "x", calls: [{ kind: "extract", model, answer: {} }], observed: proposed({ outcome }), verdict: { misses: miss, violations: violation } }] };
}

describe("the report", () => {
  const clean = GATE_SCENARIOS.map((id) => runOf(id, [], []));

  it("counts what was run, lists every miss and violation, and says which model answered", () => {
    const run: ModelRun = { model: "free/one:free", paid: false, runs: [...clean, runOf("food-wanted", ["slot gift held BOTTLE-STEEL, expected TRUFFLES-BOX"], []), runOf("over-budget", [], ["a bug"], "paid/two", "FAILED")] };
    const s = summarize(run);
    expect(s).toMatchObject({ scenarios: 6, turns: 6, failedTurns: 1, gate: false });
    expect(s.answered).toEqual({ "m1": 5, "paid/two": 1 });
    const text = renderReport({ date: "2026-11-05", runs: [run] });
    expect(text).toContain("slot gift held BOTTLE-STEEL, expected TRUFFLES-BOX");
    expect(text).toContain("`over-budget` turn 1: a bug");
    expect(text).toContain("paid/two (1 answers)");
    expect(text).toContain("No free candidate went cleanly through the gate scenarios");
  });

  it("names the first free candidate that went cleanly through the gate", () => {
    const runs: ModelRun[] = [
      { model: "free/bad:free", paid: false, runs: [runOf("hostile-price", ["x"], []), ...GATE_SCENARIOS.filter((g) => g !== "hostile-price").map((id) => runOf(id, [], []))] },
      { model: "free/good:free", paid: false, runs: clean },
      { model: "paid/model", paid: true, runs: clean },
    ];
    expect(renderReport({ date: "2026-11-05", runs })).toContain("`free/good:free`");
  });

  it("states the timeout when it differs from the app's, so a longer one is never hidden", () => {
    const runs: ModelRun[] = [{ model: "free/one:free", paid: false, runs: clean }];
    expect(renderReport({ date: "2026-11-05", runs, timeoutMs: 60_000 })).toContain("Per-request timeout: 60 s, longer than the 20 s the app allows.");
    expect(renderReport({ date: "2026-11-05", runs, timeoutMs: 20_000 })).toContain("Per-request timeout: 20 s, the same as the app.");
    expect(renderReport({ date: "2026-11-05", runs })).not.toContain("Per-request timeout");
  });

  it("makes no claim of a rate, a score, a speed or a saving", () => {
    const text = renderReport({ date: "2026-11-05", runs: [{ model: "free/one:free", paid: false, runs: clean }] });
    expect(text.replace("No accuracy, speed or saving figure is claimed.", "")).not.toMatch(/\d\s*%|percent|accuracy|success rate|pass rate|faster|seconds|\bms\b|latency|saved|saving/i);
    expect(text).toContain("No accuracy, speed or saving figure is claimed");
  });
});

describe("specification fields are what the scorer reads", () => {
  it("knows every field the pipeline stores", () => {
    const names: FieldName[] = [...FIELD_NAMES];
    expect(Object.keys(blankFields()).sort()).toEqual(names.sort());
  });
});
