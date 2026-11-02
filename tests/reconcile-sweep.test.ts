import { describe, expect, it, vi } from "vitest";
import type { AuditRow } from "@/lib/audit";
import { handleReconcile, type ReconcileDeps, type SweepSummary } from "@/lib/cron/reconcile-handler";

const SECRET = "cron-secret-with-plenty-of-length-0123";
const summary: SweepSummary = { expiredReleased: 2, orphansReleased: 1, staleFlagged: 0, orphansFlagged: 0 };

function makeDeps(overrides: Partial<ReconcileDeps> = {}) {
  const rows: AuditRow[] = [];
  const insertAudit = vi.fn(async (row: AuditRow) => void rows.push(row));
  const deps: ReconcileDeps = { cronSecret: SECRET, insertAudit, ...overrides };
  return { deps, rows, insertAudit };
}

const post = (headers: Record<string, string> = { authorization: `Bearer ${SECRET}`, "x-correlation-id": "corr-from-cron-1" }) =>
  new Request("http://localhost/api/cron/reconcile", { method: "POST", headers, body: "{}" });

describe("reconcile handler: reservation sweep", () => {
  it("runs the sweep once, after the heartbeat, with the clock and the correlation id", async () => {
    const order: string[] = [];
    const sweepReservations = vi.fn(async () => {
      order.push("sweep");
      return summary;
    });
    const { deps, insertAudit } = makeDeps({ sweepReservations, now: () => "2026-11-03T10:00:00.000Z" });
    insertAudit.mockImplementation(async () => void order.push("heartbeat"));

    const response = await handleReconcile(post(), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(order).toEqual(["heartbeat", "sweep"]);
    expect(sweepReservations).toHaveBeenCalledTimes(1);
    expect(sweepReservations).toHaveBeenCalledWith({ now: "2026-11-03T10:00:00.000Z", correlationId: "corr-from-cron-1" });
  });

  it("does not run the sweep for an unauthorized request", async () => {
    const sweepReservations = vi.fn(async () => summary);
    const { deps, rows } = makeDeps({ sweepReservations });
    const response = await handleReconcile(post({}), deps);
    expect(response.status).toBe(401);
    expect(sweepReservations).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("behaves exactly as before when no sweep is injected", async () => {
    const { deps, rows } = makeDeps();
    const response = await handleReconcile(post(), deps);
    expect(response.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("reconcile.heartbeat");
  });

  it("a failing sweep still leaves the heartbeat, and shows up as a 500 the scheduler can see, without revealing why", async () => {
    const sweepReservations = vi.fn(async () => {
      throw new Error("relation does not exist: secret-table-name");
    });
    const { deps, rows } = makeDeps({ sweepReservations });
    const response = await handleReconcile(post(), deps);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe(JSON.stringify({ error: "sweep_failed" }));
    expect(body).not.toContain("secret-table-name");
    expect(rows.map((r) => r.action)).toEqual(["reconcile.heartbeat"]);
  });

  it("a failing heartbeat does not run the sweep", async () => {
    const sweepReservations = vi.fn(async () => summary);
    const { deps } = makeDeps({ sweepReservations, insertAudit: vi.fn(async () => Promise.reject(new Error("db down"))) });
    const response = await handleReconcile(post(), deps);
    expect(response.status).toBe(500);
    expect(sweepReservations).not.toHaveBeenCalled();
  });
});
