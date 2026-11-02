// Evidence label for every test here: MOCKED. The PayPal side is tests/support/fake-paypal.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuditRow } from "@/lib/audit";
import { createPayPalClient } from "@/lib/paypal/client";
import {
  SPIKE_AMOUNT,
  createSpikeOrder,
  finishSpike,
  waitForApproval,
  type SpikeDeps,
  type SpikeEventRow,
} from "@/lib/paypal/spike";
import { startFakePayPal, type FakePayPal } from "./support/fake-paypal";

let fake: FakePayPal;

beforeAll(async () => {
  fake = await startFakePayPal();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.requests.length = 0;
});

function makeDeps(overrides: Partial<SpikeDeps> = {}) {
  const events: SpikeEventRow[] = [];
  const audits: AuditRow[] = [];
  const deps: SpikeDeps = {
    client: createPayPalClient({
      env: "sandbox",
      clientId: "spike-client",
      clientSecret: "spike-secret-value-123456",
      baseUrl: fake.url,
      timeoutMs: 300,
    }),
    recordEvent: async (row) => void events.push(row),
    insertAudit: async (row) => void audits.push(row),
    evidenceLabel: "mocked",
    correlationId: "spike-corr-12345678",
    actor: "cli",
    ...overrides,
  };
  return { deps, events, audits };
}

/** Create an order and have the (fake) buyer approve it. */
async function approvedOrder(deps: SpikeDeps) {
  const created = await createSpikeOrder(deps);
  expect(created.orderId).toBeTruthy();
  expect(fake.approve(created.orderId!)).toBe(true);
  return created.orderId!;
}

const stepNames = (r: { steps: Array<{ step: string }> }) => r.steps.map((s) => s.step);
const capturesFor = (orderId: string) =>
  [...fake.captures.values()].filter((c) => fake.authorizations.get(c.authorizationId)?.orderId === orderId);
const requestsTo = (suffix: string) => fake.requests.filter((r) => r.method === "POST" && r.path.endsWith(suffix));

describe("authorize then capture", () => {
  it("holds the funds, captures them once, and records evidence for every step", async () => {
    const { deps, events, audits } = makeDeps();
    const created = await createSpikeOrder(deps);
    expect(created.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    fake.approve(created.orderId!);

    const report = await finishSpike(deps, { orderId: created.orderId!, mode: "capture" });

    expect(report.ok).toBe(true);
    expect(stepNames(report)).toEqual(["authorized", "captured"]);
    const captures = capturesFor(created.orderId!);
    expect(captures).toHaveLength(1);
    expect(captures[0].amount).toBe("10.80");
    expect([...fake.authorizations.values()].find((a) => a.orderId === created.orderId)?.status).toBe("CAPTURED");

    expect(events.map((e) => e.event_type)).toEqual(["spike.order_created", "spike.authorized", "spike.captured"]);
    expect(events.every((e) => e.source === "spike" && e.evidence_label === "mocked")).toBe(true);
    expect(audits.map((a) => a.action)).toEqual(["spike.order_created", "spike.authorized", "spike.captured"]);
    expect(audits.every((a) => a.correlation_id === "spike-corr-12345678" && a.actor === "cli")).toBe(true);
  });

  it("charges the fixed demo amount, taken from code and not from anywhere else", async () => {
    const { deps } = makeDeps();
    const created = await createSpikeOrder(deps);
    expect(SPIKE_AMOUNT).toBe(1080);
    expect(fake.orders.get(created.orderId!)?.amount).toBe("10.80");
  });

  it("uses a stable idempotency key per operation, derived from the order", async () => {
    const { deps } = makeDeps();
    const orderId = await approvedOrder(deps);
    await finishSpike(deps, { orderId, mode: "capture" });
    expect(requestsTo("/authorize")[0].requestId).toBe(`spike-${orderId}-authorize`);
    expect(requestsTo("/capture")[0].requestId).toBe(`spike-${orderId}-capture`);
  });
});

describe("authorize then void", () => {
  it("voids the hold, then confirms with PayPal that it is released", async () => {
    const { deps } = makeDeps();
    const orderId = await approvedOrder(deps);
    const report = await finishSpike(deps, { orderId, mode: "void" });

    expect(report.ok).toBe(true);
    expect(stepNames(report)).toEqual(["authorized", "voided"]);
    expect([...fake.authorizations.values()].find((a) => a.orderId === orderId)?.status).toBe("VOIDED");
    expect(capturesFor(orderId)).toHaveLength(0);
    // It looked, rather than trusting the void reply.
    expect(fake.requests.some((r) => r.method === "GET" && r.path.includes("/authorizations/"))).toBe(true);
  });
});

describe("guards", () => {
  it("does nothing to an order the buyer has not approved", async () => {
    const { deps } = makeDeps();
    const created = await createSpikeOrder(deps);
    const report = await finishSpike(deps, { orderId: created.orderId!, mode: "capture" });

    expect(report.ok).toBe(false);
    expect(stepNames(report)).toEqual(["not_approved"]);
    expect(requestsTo("/authorize")).toHaveLength(0);
  });

  it("refuses to capture when the authorization does not match the order amount", async () => {
    const { deps } = makeDeps();
    const orderId = await approvedOrder(deps);
    fake.orders.get(orderId)!.amount = "9.99"; // PayPal says one amount, our records say another

    const report = await finishSpike(deps, { orderId, mode: "capture" });

    expect(report.ok).toBe(false);
    expect(stepNames(report)).toEqual(["financial_exception"]);
    expect(requestsTo("/capture")).toHaveLength(0);
    expect(capturesFor(orderId)).toHaveLength(0);
  });

  it("surfaces a PayPal refusal as a failure and does not retry", async () => {
    const { deps } = makeDeps();
    const orderId = await approvedOrder(deps);
    fake.inject("/capture", { type: "status", status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] } });

    const report = await finishSpike(deps, { orderId, mode: "capture" });

    expect(report.ok).toBe(false);
    expect(stepNames(report)).toEqual(["authorized", "capture_failed"]);
    expect(report.steps[1].detail).toContain("INSTRUMENT_DECLINED");
    expect(requestsTo("/capture")).toHaveLength(1);
  });
});

describe("unknown outcomes: query PayPal, never retry blindly", () => {
  it("capture happened but the answer was lost: finds it by asking, with exactly one capture", async () => {
    const { deps } = makeDeps();
    const orderId = await approvedOrder(deps);
    fake.inject("/capture", { type: "drop-after" });

    const report = await finishSpike(deps, { orderId, mode: "capture" });

    expect(stepNames(report)).toEqual(["authorized", "capture_failed", "capture_confirmed_by_query"]);
    expect(report.steps[1].outcome).toBe("unknown");
    expect(report.ok).toBe(false); // the unknown step is still on the record
    expect(requestsTo("/capture")).toHaveLength(1);
    expect(capturesFor(orderId)).toHaveLength(1);
  });

  it("capture never reached PayPal: says it has not happened, and does not retry on its own", async () => {
    const { deps } = makeDeps();
    const orderId = await approvedOrder(deps);
    fake.inject("/capture", { type: "hang" });

    const report = await finishSpike(deps, { orderId, mode: "capture" });

    expect(stepNames(report)).toEqual(["authorized", "capture_failed", "capture_not_found"]);
    expect(report.steps[2].outcome).toBe("unknown");
    expect(requestsTo("/capture")).toHaveLength(1);
    expect(capturesFor(orderId)).toHaveLength(0);
  });

  it("re-running after the lost answer repeats nothing: same key, same single capture", async () => {
    const { deps } = makeDeps();
    const orderId = await approvedOrder(deps);
    fake.inject("/capture", { type: "drop-after" });
    await finishSpike(deps, { orderId, mode: "capture" });

    const rerun = await finishSpike(deps, { orderId, mode: "capture" });

    expect(stepNames(rerun)).toEqual(["authorize_skipped", "captured"]);
    expect(rerun.ok).toBe(true);
    expect(capturesFor(orderId)).toHaveLength(1);
    const keys = requestsTo("/capture").map((r) => r.requestId);
    expect(new Set(keys).size).toBe(1);
  });

  it("void whose answer was lost: confirms the release by asking", async () => {
    const { deps } = makeDeps();
    const orderId = await approvedOrder(deps);
    fake.inject("/void", { type: "drop-after" });

    const report = await finishSpike(deps, { orderId, mode: "void" });

    expect(stepNames(report)).toEqual(["authorized", "void_failed", "voided"]);
    expect(report.steps[1].outcome).toBe("unknown");
    expect(requestsTo("/void")).toHaveLength(1);
  });

  it("void that never arrived: stays in a checking state instead of claiming success", async () => {
    const { deps } = makeDeps();
    const orderId = await approvedOrder(deps);
    fake.inject("/void", { type: "hang" });

    const report = await finishSpike(deps, { orderId, mode: "void" });

    expect(stepNames(report)).toEqual(["authorized", "void_failed", "void_not_confirmed"]);
    expect(report.steps.at(-1)?.outcome).toBe("unknown");
    expect(report.ok).toBe(false);
    expect([...fake.authorizations.values()].find((a) => a.orderId === orderId)?.status).toBe("CREATED");
  });

  it("authorize whose answer was lost: finds the authorization by asking, then carries on", async () => {
    const { deps } = makeDeps();
    const orderId = await approvedOrder(deps);
    fake.inject("/authorize", { type: "drop-after" });

    const report = await finishSpike(deps, { orderId, mode: "capture" });

    expect(stepNames(report)).toEqual(["authorize_failed", "authorize_confirmed_by_query", "captured"]);
    expect(requestsTo("/authorize")).toHaveLength(1);
    expect(capturesFor(orderId)).toHaveLength(1);
  });
});

describe("waitForApproval", () => {
  it("polls until the buyer approves", async () => {
    const { deps } = makeDeps();
    const created = await createSpikeOrder(deps);
    let sleeps = 0;
    const steps = await waitForApproval(deps, created.orderId!, {
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2) fake.approve(created.orderId!);
      },
    });
    expect(steps.map((s) => s.step)).toEqual(["order_approved"]);
    expect(sleeps).toBe(2);
  });

  it("gives up after the timeout", async () => {
    const { deps } = makeDeps();
    const created = await createSpikeOrder(deps);
    let clock = 0;
    const steps = await waitForApproval(deps, created.orderId!, {
      timeoutMs: 1000,
      intervalMs: 400,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });
    expect(steps.map((s) => s.step)).toEqual(["approval_timed_out"]);
    expect(steps[0].outcome).toBe("failed");
  });
});

describe("evidence and secrets", () => {
  it("carries whichever evidence label it is given", async () => {
    const { deps, events } = makeDeps({ evidenceLabel: "real-sandbox" });
    await createSpikeOrder(deps);
    expect(events[0].evidence_label).toBe("real-sandbox");
  });

  it("never records the client secret or access token", async () => {
    const { deps, events, audits } = makeDeps();
    const orderId = await approvedOrder(deps);
    await finishSpike(deps, { orderId, mode: "capture" });
    const everything = JSON.stringify({ events, audits });
    expect(everything).not.toContain("spike-secret-value-123456");
    expect(everything).not.toContain("fake-access-token");
  });
});
