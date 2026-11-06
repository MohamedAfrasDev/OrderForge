// `npm run soak:model -- --base https://order-forge.afras.dev --n 10 --model openai/gpt-oss-120b`
// Sends n requests, one at a time, through the PUBLIC customer flow of a running site in a real browser, times each one and
// writes doc/evidence/model-soak.md. It uses no secret and no admin access, and it never touches the money path: a request is
// only started, never accepted. Each run leaves n throwaway requests in the shop's inbox.
// Keep this file to erasable TypeScript (it runs under Node's --experimental-strip-types).
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_LIMIT_MS, judgeSoak, renderSoak, type SoakResult } from "./soak-report.ts";

const PREPARED_MESSAGE = "We need 20 welcome boxes for a conference. Something with notebooks, no food please, and our logo on it. Keep it under $40 per box.";
const HANDOFF_TEXT = "could not answer just now";
const BROWSER_WAIT_MS = 90_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const base = (arg("base") ?? "").replace(/\/+$/, "");
const n = Number(arg("n") ?? "10");
const store = arg("store") ?? "demo-gift-boxes";
const modelLabel = arg("model") ?? null;

if (!/^https?:\/\/[^/\s]+$/.test(base)) {
  console.error("Usage: npm run soak:model -- --base https://your-site [--n 10] [--store demo-gift-boxes] [--model <name>] [--out <file>]");
  process.exit(2);
}
if (!Number.isInteger(n) || n < 1 || n > 20) {
  console.error("--n must be a whole number from 1 to 20 (each request leaves a throwaway request and spends model credit)");
  process.exit(2);
}
if (!/^[a-z0-9-]{1,60}$/.test(store)) {
  console.error("--store must be a store slug");
  process.exit(2);
}
const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname);
// A local run prints its report and writes nothing unless asked, so it can never overwrite the hosted evidence.
const out = arg("out") ?? (isLocal ? null : "doc/evidence/model-soak.md");

const playwright = await import("@playwright/test");
const chromium = playwright.chromium ?? (playwright as unknown as { default: typeof playwright }).default.chromium;

const browser = await chromium.launch();
const results: SoakResult[] = [];
const startedAt = new Date().toISOString();

for (let i = 1; i <= n; i += 1) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const started = Date.now();
  let result: SoakResult;
  try {
    await page.goto(`${base}/store/${store}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByLabel("Describe the custom order you have in mind").fill(PREPARED_MESSAGE);
    const pressed = Date.now();
    await page.getByRole("button", { name: "Start my request" }).click();
    await page.waitForURL(/\/o\//, { timeout: BROWSER_WAIT_MS });
    const ms = Date.now() - pressed;
    const text = await page.locator("body").innerText();
    result = text.includes(HANDOFF_TEXT) ? { index: i, ms, outcome: "handoff", detail: "the assistant could not answer" } : { index: i, ms, outcome: "answered" };
  } catch (e) {
    const kind = e instanceof Error && /timeout/i.test(e.message) ? `no order room within ${BROWSER_WAIT_MS / 1000} s` : "the page did not respond as expected";
    result = { index: i, ms: Date.now() - started, outcome: "error", detail: kind };
  }
  results.push(result);
  console.log(`#${i}: ${(result.ms / 1000).toFixed(1)} s ${result.outcome}${result.detail ? ` (${result.detail})` : ""}`);
  await context.close();
}
await browser.close();

let commit: string | null = null;
try {
  commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
} catch {
  commit = null;
}
const input = { base, store, modelLabel, startedAt, results, planned: n, limitMs: DEFAULT_LIMIT_MS };
const report = renderSoak(input, commit);
const verdict = judgeSoak(input);
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report, "utf8");
  console.log(`Wrote ${out}`);
} else {
  console.log("\n" + report);
}
console.log(verdict.pass ? "PASS" : "NOT A PASS");
process.exit(verdict.pass ? 0 : 1);
