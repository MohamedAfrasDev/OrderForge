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

const post = (headers: Record<string, string> = { authorization: `Bearer ${SECRET}`, "x-correlation-id": "corr-pay-1" }) =>
  new Request("http://localhost/api/cron/reconcile", { method: "POST", headers, body: "{}" });

describe("reconcile handler: payments reconciliation", () => {
  it("runs payments after the heartbeat and BEFORE the reservation sweep, with the clock and correlation id", async () => {
    const reconcilePayments = vi.fn(async () => void 0);
    const sweepReservations = vi.fn(async () => sweepSummary);
    const { deps, order } = makeDeps({ reconcilePayments, sweepReservations });
    reconcilePayments.mockImplementation(async () => void order.push("payments"));
    sweepReservations.mockImplementation(async () => (order.push("sweep"), sweepSummary));

    const response = await handleReconcile(post(), deps);
    expect(response.status).toBe(200);
    expect(order).toEqual(["heartbeat", "payments", "sweep"]);
    expect(reconcilePayments).toHaveBeenCalledWith({ now: "2026-11-03T10:00:00.000Z", correlationId: "corr-pay-1" });
  });

  it("a failing payments run still lets the sweep finish, then fails the run visibly", async () => {
    const reconcilePayments = vi.fn(async () => {
      throw new Error("secret detail that must not leak");
    });
    const sweepReservations = vi.fn(async () => sweepSummary);
    const { deps } = makeDeps({ reconcilePayments, sweepReservations });
    const response = await handleReconcile(post(), deps);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "payments_failed" });
    expect(sweepReservations).toHaveBeenCalledTimes(1);
  });

  it("a failing sweep after good payments is still reported as a sweep failure", async () => {
    const reconcilePayments = vi.fn(async () => void 0);
    const sweepReservations = vi.fn(async () => {
      throw new Error("boom");
    });
    const { deps } = makeDeps({ reconcilePayments, sweepReservations });
    const response = await handleReconcile(post(), deps);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "sweep_failed" });
    expect(reconcilePayments).toHaveBeenCalledTimes(1);
  });

  it("does not reconcile anything for an unauthorized request", async () => {
    const reconcilePayments = vi.fn(async () => void 0);
    const { deps } = makeDeps({ reconcilePayments });
    expect((await handleReconcile(post({}), deps)).status).toBe(401);
    expect(reconcilePayments).not.toHaveBeenCalled();
  });

  it("is unchanged when no payments reconciliation is injected", async () => {
    const { deps } = makeDeps();
    expect((await handleReconcile(post(), deps)).status).toBe(200);
  });
});
