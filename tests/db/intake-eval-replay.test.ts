// Real local Postgres. Two things, labeled apart:
//  - MOCKED: every scenario runs through the real pipeline with the rule-based stand-in. This proves the harness and the scorer work
//    on the real code and that no scenario breaks what the code guarantees. It says nothing about any model.
//  - REPLAYED: the answers a real model gave in the recorded run (eval/intake/fixtures/replay.json) are fed back through the same
//    pipeline. It must reproduce what was observed then, and the code's guarantees must hold on every turn, whatever the model got
//    wrong. The model's misses are results of the manual run, not failures of this test.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakeModel, createLocalDemoModel, type FakeStep, type ModelKind } from "@/lib/ai";
import { recording, runScenario, type RecordedCall } from "../../eval/intake/harness";
import type { Observed } from "../../eval/intake/score";
import { SCENARIOS } from "../../eval/intake/scenarios";
import { serviceClient } from "./helpers";

const db = serviceClient();
const FIXTURES = "eval/intake/fixtures/replay.json";

describe("MOCKED: the scenarios through the real pipeline with the stand-in model", () => {
  it("plays every scenario to the end and never breaks what the code guarantees", async () => {
    const model = recording(createLocalDemoModel());
    for (const scenario of SCENARIOS) {
      const run = await runScenario(db, scenario, model);
      expect(run.turns, scenario.id).toHaveLength(scenario.turns.length);
      for (const [i, t] of run.turns.entries()) expect(t.verdict.violations, `${scenario.id} turn ${i + 1}`).toEqual([]);
    }
  });

  it("reads the demo request the way the spec says (step A through the scenario harness)", async () => {
    const scenario = SCENARIOS.find((s) => s.id === "all-requirements-at-once")!;
    const run = await runScenario(db, scenario, recording(createLocalDemoModel()));
    expect(run.turns[0]!.verdict).toEqual({ misses: [], violations: [] });
  });

  it("breaks stock at 30 boxes and offers the organizer (step D through the harness)", async () => {
    const scenario = SCENARIOS.find((s) => s.id === "quantity-breaks-stock")!;
    const run = await runScenario(db, scenario, recording(createLocalDemoModel()));
    const second = run.turns[1]!;
    expect(second.observed.proposal?.blockers).toContain("INSUFFICIENT_STOCK");
    expect(second.observed.proposal?.alternatives.map((a) => a.toSku)).toContain("ORGANIZER-DESK");
    expect(second.verdict.violations).toEqual([]);
  });
});

type Fixture = { recordedAt: string; model: string; promptVersion: string; scenarios: Record<string, Array<{ calls: RecordedCall[]; observed: Observed }>> };

const recorded = existsSync(FIXTURES) ? (JSON.parse(readFileSync(FIXTURES, "utf8")) as Fixture) : null;

describe.skipIf(recorded === null)("REPLAYED: answers recorded from a real model", () => {
  it("covers every scenario in the set", () => {
    expect(Object.keys(recorded!.scenarios).sort()).toEqual(SCENARIOS.map((s) => s.id).sort());
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: reproduces what was observed, and the code's guarantees hold on every turn`, async () => {
      const turns = recorded!.scenarios[scenario.id]!;
      // One scripted model for the whole scenario: each turn takes its own recorded answers, kind by kind, in order.
      const queues: Partial<Record<ModelKind, FakeStep[]>> = {};
      for (const turn of turns) {
        for (const c of turn.calls) (queues[c.kind] ??= []).push(c.failure ? { fail: c.failure } : c.answer);
      }
      const run = await runScenario(db, scenario, recording(createFakeModel({ answers: queues, model: recorded!.model })));
      expect(run.turns).toHaveLength(turns.length);
      for (const [i, t] of run.turns.entries()) {
        expect(t.observed, `turn ${i + 1}`).toEqual(turns[i]!.observed);
        expect(t.verdict.violations, `turn ${i + 1}`).toEqual([]);
      }
    });
  }
});
