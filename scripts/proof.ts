// `npm run proof`: run the unit and database suites, read the evaluation reports, write doc/evidence/proof-points.md.
// Add `--with-e2e` to also run the browser tests (they start the app, so they are slower and opt-in).
// Exits non-zero if a required suite did not run or any test failed. Never writes zeros for a suite that did not run.
// Keep this file to erasable TypeScript (it runs under Node's --experimental-strip-types).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROOF_MAP,
  checkProofMapFiles,
  parseEvalReport,
  parsePlaywrightJson,
  parseVitestJson,
  renderProof,
  type Counts,
  type EvalReport,
  type SuiteResult,
} from "./proof-render.ts";

const withE2e = process.argv.includes("--with-e2e");
const work = mkdtempSync(join(tmpdir(), "orderforge-proof-"));
const OUT = "doc/evidence/proof-points.md";

const missing = checkProofMapFiles(PROOF_MAP, existsSync);
if (missing.length > 0) {
  console.error(`The proof map names files that do not exist: ${missing.join(", ")}`);
  process.exit(2);
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

const dirty = git(["status", "--porcelain", "--", ".", ":!doc/evidence/proof-points.md"]) !== "";
const commit = `${git(["rev-parse", "--short", "HEAD"]) || "unknown"}${dirty ? " plus uncommitted changes" : ""}`;

type Spec = { id: SuiteResult["id"]; title: string; label: string; command: string; args: string[]; parse: (j: unknown) => Counts; report: string };

function vitestSpec(id: "unit" | "db"): Spec {
  const report = join(work, `${id}.json`);
  const config = id === "db" ? ["--config", "vitest.db.config.ts"] : [];
  return {
    id,
    title: id === "unit" ? "Unit tests" : "Database tests",
    label:
      id === "unit"
        ? "mocked and scripted: pure logic, fake PayPal, stand-in and scripted models, no network"
        : "local database (Docker Supabase) with the real SQL; PayPal and the model mocked",
    command: id === "unit" ? "npm run test" : "npm run test:db",
    args: ["node_modules/vitest/vitest.mjs", "run", ...config, "--reporter=json", `--outputFile=${report}`],
    parse: parseVitestJson,
    report,
  };
}

function e2eSpec(): Spec {
  const report = join(work, "e2e.json");
  return {
    id: "e2e",
    title: "End-to-end tests",
    label: "mocked: stand-in model, fake PayPal, fake email; local stack",
    command: "npm run test:e2e",
    args: ["node_modules/@playwright/test/cli.js", "test", "--reporter=json"],
    parse: parsePlaywrightJson,
    report,
  };
}

function run(spec: Spec): SuiteResult {
  const base = { id: spec.id, title: spec.title, command: spec.command, label: spec.label };
  const empty = { files: 0, passed: 0, failed: 0, skipped: 0, todo: 0, failedTests: [] as string[] };
  console.log(`Running ${spec.command} ...`);
  const env = spec.id === "e2e" ? { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: spec.report } : process.env;
  const r = spawnSync(process.execPath, spec.args, { stdio: ["ignore", "inherit", "inherit"], env });
  if (r.error || !existsSync(spec.report)) {
    console.error(`${spec.command}: no report was produced (${r.error?.message ?? `exit ${r.status}`}).`);
    return { ...base, ran: false, ...empty };
  }
  try {
    return { ...base, ran: true, ...spec.parse(JSON.parse(readFileSync(spec.report, "utf8"))) };
  } catch (e) {
    console.error(`${spec.command}: ${(e as Error).message}`);
    return { ...base, ran: false, ...empty };
  }
}

const specs = [vitestSpec("unit"), vitestSpec("db"), ...(withE2e ? [e2eSpec()] : [])];
const suites = specs.map(run);
if (!withE2e) {
  suites.push({
    id: "e2e",
    title: "End-to-end tests",
    command: "npm run test:e2e",
    label: "mocked",
    ran: false,
    files: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    failedTests: [],
  });
}

const evalDir = "eval/intake/reports";
const evals: EvalReport[] = existsSync(evalDir)
  ? readdirSync(evalDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => parseEvalReport(readFileSync(join(evalDir, f), "utf8"), `${evalDir}/${f}`))
  : [];

const date = new Date().toISOString().slice(0, 10);
mkdirSync("doc/evidence", { recursive: true });
writeFileSync(OUT, renderProof({ date, commit, suites, evals }), "utf8");
console.log(`Wrote ${OUT}`);

const required = suites.filter((s) => s.id !== "e2e" || withE2e);
const notRun = required.filter((s) => !s.ran);
const failed = required.filter((s) => s.ran && s.failed > 0);
if (notRun.length > 0) console.error(`Not run: ${notRun.map((s) => s.title).join(", ")}`);
if (failed.length > 0) console.error(`Failing: ${failed.map((s) => s.title).join(", ")}`);
process.exit(notRun.length > 0 || failed.length > 0 ? 1 : 0);
