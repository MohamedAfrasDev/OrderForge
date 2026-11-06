// Pure part of `npm run proof`: parse test-runner reports and evaluation reports, render the evidence file.
// No file, network or clock access here, so it can be unit tested. Keep this file to erasable TypeScript
// (it also runs under Node's --experimental-strip-types).

export type SuiteId = "unit" | "db" | "e2e";

export type SuiteResult = {
  id: SuiteId;
  title: string;
  command: string;
  /** How the evidence in this suite is labeled: what is real and what is mocked. */
  label: string;
  /** false when the suite was not run (or produced no readable report). */
  ran: boolean;
  files: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  failedTests: string[];
};

export type Counts = Pick<SuiteResult, "files" | "passed" | "failed" | "skipped" | "todo" | "failedTests">;

export type EvalModel = { model: string; scenarios: number; turns: number; unusable: number; misses: number; violations: number };

export type EvalReport = { file: string; runOn: string; label: string; models: EvalModel[]; missList: string[] };

export type ProofRow = {
  failureMode: string;
  guarantee: string;
  /** Test files that cover it. Each must exist (checked by a test, so a rename is caught). */
  tests: string[];
  /** Hand-written evidence of a real run. Each must exist. */
  evidence: string[];
};

export const PROOF_MAP: ProofRow[] = [
  {
    failureMode: "A stale price is paid",
    guarantee: "An authorization belongs to one quote version (a SHA-256 over canonical JSON); a changed quote cannot reuse it.",
    tests: ["tests/quote/canonical.test.ts", "tests/quote/gate.test.ts", "tests/db/quote-accept.test.ts", "tests/db/payments-checkout.test.ts"],
    evidence: ["doc/evidence/payments-real-sandbox.md"],
  },
  {
    failureMode: "A customer is charged twice",
    guarantee: "A repeated or racing merchant decision, capture or webhook produces no second charge and no second preparation job.",
    tests: [
      "tests/db/payments-decide.test.ts",
      "tests/db/payments-webhook.test.ts",
      "tests/db/payments-reconcile.test.ts",
      "tests/payments/request-id-classify.test.ts",
      "tests/db/fulfillment-create.test.ts",
    ],
    evidence: ["doc/evidence/payments-real-sandbox.md", "doc/evidence/fulfillment-real-sandbox.md"],
  },
  {
    failureMode: "Stock that is not there is sold",
    guarantee: "Stock is reserved under a row lock in one database call; a configuration is validated against live stock; timers never release stock while a PayPal operation may be in flight.",
    tests: [
      "tests/db/reservation-reserve.test.ts",
      "tests/db/reservation-guards.test.ts",
      "tests/db/reservation-sweep.test.ts",
      "tests/reservation/invariant.test.ts",
      "tests/catalog/validate-stock-budget.test.ts",
    ],
    evidence: [],
  },
  {
    failureMode: "The model touches the money",
    guarantee: "Model output cannot set a price, quantity, status or state; strict schemas reject extra fields; every configuration shown was validated and priced by code.",
    tests: ["tests/intake/tools.test.ts", "tests/intake/extraction.test.ts", "tests/intake/eval-scenarios.test.ts", "tests/db/intake-injection.test.ts"],
    evidence: ["doc/evidence/ai-intake-real-model.md"],
  },
  {
    failureMode: "The wrong person sees an order",
    guarantee: "Access is enforced on the server for every query: customer links are checked, shop pages see only the signed-in owner's rows.",
    tests: ["tests/db/rls.test.ts", "tests/db/inquiry-reads.test.ts", "tests/merchant-access.test.ts", "tests/customer-link.test.ts"],
    evidence: [],
  },
];

export function checkProofMapFiles(map: readonly ProofRow[], exists: (path: string) => boolean): string[] {
  const missing: string[] = [];
  for (const row of map) for (const p of [...row.tests, ...row.evidence]) if (!exists(p)) missing.push(p);
  return missing;
}

function relativeTestName(name: string): string {
  const unix = name.replace(/\\/g, "/");
  const i = unix.indexOf("/tests/");
  return i >= 0 ? unix.slice(i + 1) : unix;
}

/** Counts from a vitest `--reporter=json` report. Refuses anything else so a broken run never reads as zero failures. */
export function parseVitestJson(json: unknown): Counts {
  const results = (json as { testResults?: unknown } | null)?.testResults;
  if (!Array.isArray(results)) throw new Error("Not a vitest JSON report (no testResults).");
  const counts: Counts = { files: results.length, passed: 0, failed: 0, skipped: 0, todo: 0, failedTests: [] };
  for (const file of results as Array<{ name?: string; assertionResults?: Array<{ status?: string; fullName?: string }> }>) {
    for (const t of file.assertionResults ?? []) {
      if (t.status === "passed") counts.passed += 1;
      else if (t.status === "failed") {
        counts.failed += 1;
        counts.failedTests.push(`${relativeTestName(file.name ?? "unknown")}: ${t.fullName ?? "unnamed test"}`);
      } else if (t.status === "todo") counts.todo += 1;
      else counts.skipped += 1;
    }
  }
  if (counts.passed + counts.failed + counts.skipped + counts.todo === 0) throw new Error("The vitest report contains no tests.");
  return counts;
}

/** Counts from a Playwright `--reporter=json` report (its `stats` block). */
export function parsePlaywrightJson(json: unknown): Counts {
  const stats = (json as { stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number } } | null)?.stats;
  if (!stats || typeof stats.expected !== "number" || typeof stats.unexpected !== "number") throw new Error("Not a Playwright JSON report (no stats).");
  const passed = stats.expected + (stats.flaky ?? 0);
  if (passed + stats.unexpected + (stats.skipped ?? 0) === 0) throw new Error("The Playwright report contains no tests.");
  return {
    files: 0,
    passed,
    failed: stats.unexpected,
    skipped: stats.skipped ?? 0,
    todo: 0,
    failedTests: stats.unexpected > 0 ? [`${stats.unexpected} end-to-end test(s) failed; see the Playwright report`] : [],
  };
}

export function parseEvalReport(source: string, file: string): EvalReport {
  // Reports checked out on Windows have CRLF line endings.
  const markdown = source.replace(/\r\n/g, "\n");
  const runOn = /^Run on (\d{4}-\d{2}-\d{2})/m.exec(markdown)?.[1];
  const label = /Label: \*\*([^*]+)\*\*/.exec(markdown)?.[1];
  const models: EvalModel[] = [];
  const re = /^## (.+)\n\nScenarios run: (\d+)\. Turns: (\d+)\. Turns where the model could not be used: (\d+)\.\nMisses: (\d+)\. Violations: (\d+)\./gm;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) {
    models.push({ model: m[1], scenarios: Number(m[2]), turns: Number(m[3]), unusable: Number(m[4]), misses: Number(m[5]), violations: Number(m[6]) });
  }
  if (!runOn || !label || models.length === 0) throw new Error(`Cannot read the evaluation report ${file}.`);

  const missList: string[] = [];
  const section = /### Misses \(every one\)\n\n([\s\S]*?)(?:\n#{2,3} |\n*$)/.exec(markdown);
  if (section) for (const line of section[1].split("\n")) if (line.startsWith("- ")) missList.push(line.slice(2).trim());
  return { file, runOn, label, models, missList };
}

export type ProofInput = { date: string; commit: string; suites: SuiteResult[]; evals: EvalReport[] };

function suiteRow(s: SuiteResult): string {
  if (!s.ran) return `| ${s.title} | \`${s.command}\` | ${s.label} | not run | | | |`;
  const files = s.files > 0 ? String(s.files) : "n/a";
  return `| ${s.title} | \`${s.command}\` | ${s.label} | ${files} | ${s.passed} | ${s.failed} | ${s.skipped + s.todo} |`;
}

function list(items: string[], empty: string): string {
  return items.length ? items.map((i) => `\`${i}\``).join(", ") : empty;
}

export function renderProof(input: ProofInput): string {
  const { date, commit, suites, evals } = input;
  const lines: string[] = [];
  const failing = suites.filter((s) => s.ran && s.failed > 0);
  const notRun = suites.filter((s) => !s.ran);

  lines.push("# Proof points", "");
  lines.push(`Generated by \`npm run proof\` on commit \`${commit}\` on ${date}. Do not edit by hand; run the command again.`, "");
  lines.push(
    "This file turns real test runs into a table. Every number below came from a command listed here, run on that commit. " +
      "No speed, saving, demand or accuracy figure is claimed anywhere in this project; the counts say what was run, not how good the product is.",
    "",
  );

  lines.push("## Result of this run", "");
  if (failing.length > 0) lines.push(`**FAILING:** ${failing.map((s) => s.title).join(", ")}. The failing tests are listed below.`, "");
  else if (notRun.length === 0) lines.push("All suites that this command ran passed.", "");
  if (notRun.length > 0) lines.push(`Not run in this pass: ${notRun.map((s) => s.title).join(", ")}.`, "");

  lines.push("## Test suites", "");
  lines.push("| Suite | Command | Label | Files | Passed | Failed | Skipped or todo |", "|---|---|---|---|---|---|---|");
  for (const s of suites) lines.push(suiteRow(s));
  lines.push("");
  for (const s of failing) {
    lines.push(`### Failing tests: ${s.title}`, "");
    for (const t of s.failedTests) lines.push(`- ${t}`);
    lines.push("");
  }

  lines.push("## AI evaluation (real model)", "");
  if (evals.length === 0) lines.push("No evaluation report was found in `eval/intake/reports/`.", "");
  else {
    lines.push(
      "Read from the reports in `eval/intake/reports/`, which were produced by `npm run eval:intake` against a live model. " +
        "This command does not call a model; it reads what those runs recorded. A miss is a result about the model; a violation is a bug in the pipeline. " +
        "Reports from runs where a free model was rate limited or timed out are included, not hidden.",
      "",
    );
    lines.push("| Report | Date | Label | Model | Scenarios, turns, turns where the model was unusable | Misses | Violations |", "|---|---|---|---|---|---|---|");
    for (const r of evals) {
      for (const m of r.models) {
        lines.push(
          `| \`${r.file}\` | ${r.runOn} | ${r.label} | ${m.model} | Scenarios ${m.scenarios}, turns ${m.turns}, unusable ${m.unusable} | ${m.misses} | ${m.violations} |`,
        );
      }
    }
    lines.push("");
    for (const r of evals) {
      if (r.missList.length === 0) continue;
      lines.push(`Every miss in \`${r.file}\`:`, "");
      for (const miss of r.missList) lines.push(`- ${miss}`);
      lines.push("");
    }
  }

  lines.push("## What each guarantee rests on", "");
  lines.push("| Failure mode | Guarantee | Test files (re-run by this command) | Hand-written evidence of a real run (not re-run) |", "|---|---|---|---|");
  for (const row of PROOF_MAP) {
    lines.push(`| ${row.failureMode} | ${row.guarantee} | ${list(row.tests, "none")} | ${list(row.evidence, "none yet")} |`);
  }
  lines.push("");

  lines.push("## What this command does not re-run", "");
  lines.push(
    "The real PayPal sandbox runs, the real-model runs and the hosted runs are recorded by hand in `doc/evidence/` when each was done, " +
      "after an explicit yes. They are not re-run by this command and their results are not repeated here. Mocked, replayed and scripted tests are labeled as such in their own files. " +
      "Everything in this project is sandbox-only and uses synthetic data.",
    "",
  );
  return lines.join("\n");
}
