import { describe, expect, it, vi } from "vitest";
import type { AuditRow } from "@/lib/audit";
import { handleReconcile, type ReconcileDeps } from "@/lib/cron/reconcile-handler";

const SECRET = "cron-secret-with-plenty-of-length-0123";
const sweepSummary = { expiredReleased: 0, orphansReleased: 0, staleFlagged: 0, orphansFlagged: 0 };

function makeDeps(overrides: Partial<ReconcileDeps> = {}) {
  const order: string[] = [];
  const insertAudit = vi.fn(async (row: AuditRow) => void order.push(row.action === "reconcile.heartbeat" ? "heartbeat" : "other"));
  const deps: ReconcileDeps = { cronSecret: SECRET, insertAudit, now: () => "2026-11-03T10:00:00.000Z", ...overrides };
  return { deps, order };
}

const post = (headers: Record<string, string> = { authorization: `Bearer ${SECRET}`, "x-correlation-id": "corr-jobs-1" }) =>
  new Request("http://localhost/api/cron/reconcile", { method: "POST", headers, body: "{}" });

describe("reconcile handler: creating missing jobs", () => {
  it("runs payments, then jobs, then the reservation sweep, with the clock and correlation id", async () => {
    const reconcilePayments = vi.fn(async () => void 0);
    const createMissingJobs = vi.fn(async () => void 0);
    const sweepReservations = vi.fn(async () => sweepSummary);
    const { deps, order } = makeDeps({ reconcilePayments, createMissingJobs, sweepReservations });
    reconcilePayments.mockImplementation(async () => void order.push("payments"));
    createMissingJobs.mockImplementation(async () => void order.push("jobs"));
    sweepReservations.mockImplementation(async () => (order.push("sweep"), sweepSummary));

    const response = await handleReconcile(post(), deps);
    expect(response.status).toBe(200);
    expect(order).toEqual(["heartbeat", "payments", "jobs", "sweep"]);
    expect(createMissingJobs).toHaveBeenCalledWith({ now: "2026-11-03T10:00:00.000Z", correlationId: "corr-jobs-1" });
  });

  it("jobs still run when payments fail, and the sweep still runs when jobs fail; the run then fails visibly", async () => {
    const reconcilePayments = vi.fn(async () => {
      throw new Error("PayPal down, secret detail");
    });
    const createMissingJobs = vi.fn(async () => void 0);
    const sweepReservations = vi.fn(async () => sweepSummary);
    const first = await handleReconcile(post(), makeDeps({ reconcilePayments, createMissingJobs, sweepReservations }).deps);
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({ error: "payments_failed" });
    expect(createMissingJobs).toHaveBeenCalledTimes(1);
    expect(sweepReservations).toHaveBeenCalledTimes(1);

    const jobsFail = vi.fn(async () => {
      throw new Error("database down");
    });
    const sweep2 = vi.fn(async () => sweepSummary);
    const second = await handleReconcile(post(), makeDeps({ createMissingJobs: jobsFail, sweepReservations: sweep2 }).deps);
    expect(second.status).toBe(500);
    expect(await second.json()).toEqual({ error: "jobs_failed" });
    expect(sweep2).toHaveBeenCalledTimes(1);
  });

  it("a failing sweep after good jobs is still a sweep failure", async () => {
    const createMissingJobs = vi.fn(async () => void 0);
    const sweepReservations = vi.fn(async () => {
      throw new Error("boom");
    });
    const response = await handleReconcile(post(), makeDeps({ createMissingJobs, sweepReservations }).deps);
    expect(await response.json()).toEqual({ error: "sweep_failed" });
    expect(createMissingJobs).toHaveBeenCalledTimes(1);
  });

  it("does not create anything for an unauthorized request", async () => {
    const createMissingJobs = vi.fn(async () => void 0);
    const response = await handleReconcile(post({}), makeDeps({ createMissingJobs }).deps);
    expect(response.status).toBe(401);
    expect(createMissingJobs).not.toHaveBeenCalled();
  });

  it("is unchanged when no job creation is injected", async () => {
    expect((await handleReconcile(post(), makeDeps().deps)).status).toBe(200);
  });
});
