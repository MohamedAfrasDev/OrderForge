import { PROMPT_VERSION } from "@/domain/intake";
import type { ScenarioRun } from "./harness";
import { SCENARIOS } from "./scenarios";

/** The scenarios that must go cleanly before a model can be the primary: reading a plain request, and shrugging off hostile text. */
export const GATE_SCENARIOS = ["all-requirements-at-once", "missing-quantity", "hostile-price", "hostile-system-text"] as const;

export type ModelRun = { model: string; paid: boolean; runs: ScenarioRun[] };

export type Summary = {
  scenarios: number;
  turns: number;
  /** Turns whose outcome differs from the stated one, with the reason, for every one. */
  misses: Array<{ scenario: string; turn: number; reason: string }>;
  /** Turns where something the code guarantees did not hold. Always a bug in the pipeline. */
  violations: Array<{ scenario: string; turn: number; reason: string }>;
  /** Turns where the model could not be used at all. */
  failedTurns: number;
  /** Every model that answered a question, with how many answers it gave. */
  answered: Record<string, number>;
  /** Why questions to the model failed, with how many times each (the provider's own short reason, never a key or a body). */
  failureCauses: Record<string, number>;
  /** Whether the gate scenarios went cleanly. */
  gate: boolean;
};

export function summarize(run: ModelRun): Summary {
  const misses: Summary["misses"] = [];
  const violations: Summary["violations"] = [];
  const answered: Record<string, number> = {};
  const failureCauses: Record<string, number> = {};
  let turns = 0;
  let failedTurns = 0;
  for (const s of run.runs) {
    s.turns.forEach((t, i) => {
      turns += 1;
      if (t.observed.outcome === "FAILED") failedTurns += 1;
      for (const reason of t.verdict.misses) misses.push({ scenario: s.id, turn: i + 1, reason });
      for (const reason of t.verdict.violations) violations.push({ scenario: s.id, turn: i + 1, reason });
      for (const c of t.calls) {
        if (c.failure) {
          const cause = `${c.failure}${c.detail ? `: ${c.detail}` : ""} (${c.kind})`;
          failureCauses[cause] = (failureCauses[cause] ?? 0) + 1;
        } else if (c.model) answered[c.model] = (answered[c.model] ?? 0) + 1;
      }
    });
  }
  const gateClean = GATE_SCENARIOS.every((id) => {
    const s = run.runs.find((r) => r.id === id);
    return s !== undefined && !misses.some((m) => m.scenario === id) && !violations.some((v) => v.scenario === id);
  });
  return { scenarios: run.runs.length, turns, misses, violations, failedTurns, answered, failureCauses, gate: gateClean && violations.length === 0 };
}

const titleOf = (id: string) => SCENARIOS.find((s) => s.id === id)?.title ?? id;

/**
 * The report of a manual run. It states what was run, how, and every miss and violation in full. It gives counts of what was run
 * and lists of what went wrong, never a rate, a score, a speed or a saving: the brief does not allow a claim of that kind.
 */
export function renderReport(input: { date: string; runs: ModelRun[]; timeoutMs?: number }): string {
  const lines: string[] = [];
  const first = input.runs[0] ? summarize(input.runs[0]) : null;
  lines.push("# Intake evaluation: real model", "");
  lines.push(`Run on ${input.date}. Prompt version \`${PROMPT_VERSION}\`. Label: **real-model** (kept apart from the replayed and mocked tests).`, "");
  lines.push("## Method", "");
  lines.push(
    `- ${first?.scenarios ?? SCENARIOS.length} scenarios (\`eval/intake/scenarios.ts\`), each played as a conversation of one or more customer messages, once per model.`,
    "- The real intake pipeline (the same services the app uses) ran against the LOCAL database, each scenario on a store of its own with the demo catalog and its prices, 24 steel bottles in stock, 4 Nov 2026 as the date.",
    "- The model was reached through OpenRouter with structured output at temperature 0. The free candidates ran on their own, with no paid fallback, so a free model's own answers are what is judged. A paid model, when included, ran alone and is labeled paid.",
    ...(input.timeoutMs !== undefined && input.timeoutMs !== 20_000
      ? [`- **Per-request timeout: ${input.timeoutMs / 1000} s, longer than the 20 s the app allows.** A model that needed the extra time would still time out in the app; this run shows how it answers when given time, not whether it fits the app.`]
      : input.timeoutMs === 20_000
        ? ["- Per-request timeout: 20 s, the same as the app."]
        : []),
    "- Each turn was checked against the outcome stated for it in code terms (the blocking field, the blockers, the values read, the box chosen). A difference is a **miss**: a result about the model.",
    "- Every turn was also checked against what the code guarantees whatever the model says (prices are the catalog engine's, products are real and allowed, no amount the code did not produce, a turn never makes a quote ready). A failure there is a **violation**: a bug in the pipeline.",
    "- No accuracy, speed or saving figure is claimed. The lists below are the result.",
    "",
  );

  for (const run of input.runs) {
    const s = summarize(run);
    lines.push(`## ${run.model}${run.paid ? " (paid)" : " (free)"}`, "");
    lines.push(`Scenarios run: ${s.scenarios}. Turns: ${s.turns}. Turns where the model could not be used: ${s.failedTurns}.`);
    lines.push(`Misses: ${s.misses.length}. Violations: ${s.violations.length}.`);
    lines.push(`Models that answered: ${Object.entries(s.answered).map(([m, n]) => `${m} (${n} answers)`).join(", ") || "none"}.`);
    const causes = Object.entries(s.failureCauses);
    lines.push(causes.length > 0 ? `Questions to the model that failed, by cause: ${causes.map(([c, n]) => `${c} x${n}`).join("; ")}.` : "No question to the model failed.");
    lines.push(`Gate scenarios (${GATE_SCENARIOS.join(", ")}) clean, with no violation anywhere: **${s.gate ? "yes" : "no"}**.`, "");
    if (s.violations.length > 0) {
      lines.push("### Violations (each is a bug to fix)", "");
      for (const v of s.violations) lines.push(`- \`${v.scenario}\` turn ${v.turn}: ${v.reason}`);
      lines.push("");
    }
    if (s.misses.length > 0) {
      lines.push("### Misses (every one)", "");
      for (const m of s.misses) lines.push(`- \`${m.scenario}\` turn ${m.turn} (${titleOf(m.scenario)}): ${m.reason}`);
      lines.push("");
    } else {
      lines.push("No misses.", "");
    }
  }

  const free = input.runs.filter((r) => !r.paid);
  const chosen = free.find((r) => summarize(r).gate);
  lines.push("## Choice of the free primary", "");
  if (free.length === 0) lines.push("No free candidate was run.");
  else if (chosen) lines.push(`The first free candidate, in the order they were run, whose gate scenarios were clean: \`${chosen.model}\`. The misses above remain open for the decision.`);
  else lines.push("**No free candidate went cleanly through the gate scenarios.** This is reported before any paid model becomes the primary: the decision is yours.");
  lines.push("");
  return lines.join("\n");
}
