import { describe, expect, it } from "vitest";
import { DEFAULT_LIMIT_MS, judgeSoak, renderSoak, type SoakInput, type SoakResult } from "../../scripts/soak-report";

const ok = (index: number, ms: number): SoakResult => ({ index, ms, outcome: "answered" });
const run = (results: SoakResult[], planned = results.length): SoakInput => ({ base: "https://example.test", store: "demo-gift-boxes", modelLabel: "openai/gpt-oss-120b", startedAt: "2026-11-06T10:00:00Z", results, planned, limitMs: DEFAULT_LIMIT_MS });
const tenOk = Array.from({ length: 10 }, (_, i) => ok(i + 1, 5000 + i * 100));

describe("the verdict", () => {
  it("passes only when every planned request was answered and none was over the limit", () => {
    expect(judgeSoak(run(tenOk))).toMatchObject({ pass: true, answered: 10, slow: 0, errors: 0, handoffs: 0, slowestMs: 5900 });
  });

  it("one hand-off, one error or one slow request is not a pass", () => {
    expect(judgeSoak(run([...tenOk.slice(0, 9), { index: 10, ms: 4000, outcome: "handoff" }])).pass).toBe(false);
    expect(judgeSoak(run([...tenOk.slice(0, 9), { index: 10, ms: 4000, outcome: "error" }])).pass).toBe(false);
    expect(judgeSoak(run([...tenOk.slice(0, 9), ok(10, 20_001)])).pass).toBe(false);
  });

  it("exactly at the limit still passes; a run that stopped early or planned nothing does not", () => {
    expect(judgeSoak(run([...tenOk.slice(0, 9), ok(10, 20_000)])).pass).toBe(true);
    expect(judgeSoak(run(tenOk.slice(0, 9), 10)).pass).toBe(false);
    expect(judgeSoak(run([], 0)).pass).toBe(false);
  });

  it("median is right for odd and even counts", () => {
    expect(judgeSoak(run([ok(1, 1000), ok(2, 3000), ok(3, 2000)])).medianMs).toBe(2000);
    expect(judgeSoak(run([ok(1, 1000), ok(2, 4000)])).medianMs).toBe(2500);
  });
});

describe("the report", () => {
  it("states a pass plainly, with the label, the method and the limits of the claim", () => {
    const text = renderSoak(run(tenOk), "abc1234");
    expect(text).toContain("**Pass.** 10 of 10");
    expect(text).toContain("real model, hosted");
    expect(text).toContain("commit abc1234");
    expect(text).toContain("`openai/gpt-oss-120b`, as stated by the person who ran this");
    expect(text).toContain("does not measure answer quality");
    expect(text).toContain("| 1 | 5.0 s | answered |");
  });

  it("states a failure as it is and makes no reliability claim", () => {
    const text = renderSoak(run([...tenOk.slice(0, 8), { index: 9, ms: 21_000, outcome: "handoff", detail: "the assistant could not answer" }], 10), null);
    expect(text).toContain("**Not a pass.**");
    expect(text).toContain("8 of 10 planned requests were answered");
    expect(text).toContain("1 ended in the hand-off");
    expect(text).toContain("1 not run");
    expect(text).toContain("No claim of reliability is made");
    expect(text).not.toContain("**Pass.**");
  });

  it("labels a local run as not evidence for the hosted site", () => {
    expect(renderSoak({ ...run(tenOk), base: "http://127.0.0.1:3100" }, null)).toContain("local run, not evidence for the hosted site");
    expect(renderSoak({ ...run(tenOk), base: "https://order-forge.afras.dev" }, null)).toContain("**real model, hosted**");
  });

  it("does not invent a model name when none was given, and holds no customer text", () => {
    const text = renderSoak({ ...run(tenOk), modelLabel: null }, null);
    expect(text).toContain("Model: not stated");
    expect(text).not.toContain("welcome boxes");
  });
});
