// MANUAL: the real-model evaluation. `npm run eval:intake` (see eval/intake/README.md). It calls OpenRouter with the key from .env
// and spends it (the free candidates cost nothing; a paid model costs a few cents at most), so it is never part of CI and never runs
// by accident. It runs the pipeline against the LOCAL database only: credentials come from `supabase status`, never from .env.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { PROMPT_VERSION } from "@/domain/intake";
import { createOpenRouterModel, type ModelPort } from "@/lib/ai";
import { serviceClient } from "../../tests/db/helpers";
import { recording, runScenario, type ScenarioRun } from "./harness";
import { renderReport, summarize, type ModelRun } from "./report";
import { SCENARIOS } from "./scenarios";

const FREE_CANDIDATES = ["google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free", "nvidia/nemotron-3.5-super-vl:free"];

const list = (value: string | undefined, fallback: string[]) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : fallback);

/** Only the OpenRouter key is read from .env (the file also holds the hosted database's keys, which this run must never use). */
function openRouterKey(): string {
  let text = "";
  try {
    text = readFileSync(".env", "utf8");
  } catch {
    /* handled below */
  }
  const found = /^OPENROUTER_API_KEY=(.*)$/m.exec(text);
  const key = (process.env.OPENROUTER_API_KEY ?? found?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  if (!key || key.startsWith("your-")) throw new Error("OPENROUTER_API_KEY is not set in .env");
  return key;
}

/** Free models are rate limited: keep a gap between requests so a run measures the model, not the limit. */
function paced(inner: ModelPort, gapMs: number): ModelPort {
  let last = 0;
  return {
    async complete(request) {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await inner.complete(request);
      } finally {
        last = Date.now();
      }
    },
  };
}

const db = serviceClient();

afterAll(async () => {
  // The scenarios leave stores and inquiries in the LOCAL database: clear them like the database tests do.
  await db.rpc("demo_reset");
});

describe("intake evaluation against the real model (manual)", () => {
  it(
    "runs every scenario for every candidate and writes the report",
    async () => {
      const apiKey = openRouterKey();
      const free = list(process.env.EVAL_MODELS, FREE_CANDIDATES);
      const paid = list(process.env.EVAL_PAID, []);
      const gapMs = Number(process.env.EVAL_PACE_MS ?? 3000);
      const only = list(process.env.EVAL_ONLY, []);
      const scenarios = only.length > 0 ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;

      const runs: ModelRun[] = [];
      for (const [model, isPaid] of [...free.map((m) => [m, false] as const), ...paid.map((m) => [m, true] as const)]) {
        const port = recording(paced(createOpenRouterModel({ apiKey, model, allowPaidPrimary: isPaid, ...(process.env.EVAL_TIMEOUT_MS ? { timeoutMs: Number(process.env.EVAL_TIMEOUT_MS) } : {}) }), gapMs));
        const results: ScenarioRun[] = [];
        for (const scenario of scenarios) results.push(await runScenario(db, scenario, port));
        runs.push({ model, paid: isPaid, runs: results });
        const s = summarize(runs.at(-1)!);
        console.log(`[eval] ${model}: ${s.scenarios} scenarios, ${s.misses.length} misses, ${s.violations.length} violations`);
      }

      const date = new Date().toISOString().slice(0, 10);
      mkdirSync("eval/intake/reports", { recursive: true });
      writeFileSync(`eval/intake/reports/${date}.md`, renderReport({ date, runs }));

      const record = process.env.EVAL_RECORD;
      if (record) {
        const run = runs.find((r) => r.model === record);
        if (!run) throw new Error(`EVAL_RECORD names ${record}, which was not run`);
        mkdirSync("eval/intake/fixtures", { recursive: true });
        const scenariosOut = Object.fromEntries(run.runs.map((r) => [r.id, r.turns.map((t) => ({ calls: t.calls, observed: t.observed }))]));
        writeFileSync("eval/intake/fixtures/replay.json", `${JSON.stringify({ recordedAt: date, model: run.model, promptVersion: PROMPT_VERSION, scenarios: scenariosOut }, null, 2)}\n`);
      }

      // A violation is a bug in the pipeline whatever the model did: fail loudly.
      expect(runs.flatMap((r) => summarize(r).violations)).toEqual([]);
    },
    4 * 60 * 60 * 1000,
  );
});
