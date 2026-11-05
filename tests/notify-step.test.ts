import { describe, expect, it, vi } from "vitest";
import type { AuditRow } from "@/lib/audit";
import { handleReconcile, type ReconcileDeps } from "@/lib/cron/reconcile-handler";
import { notifyBestEffort } from "@/lib/notifications/best-effort";

const SECRET = "cron-secret-with-plenty-of-length-0123";
const sweepSummary = { expiredReleased: 0, orphansReleased: 0, staleFlagged: 0, orphansFlagged: 0 };

function setup(overrides: Partial<ReconcileDeps> = {}) {
  const order: string[] = [];
  const insertAudit = vi.fn(async (row: AuditRow) => void order.push(row.action === "reconcile.heartbeat" ? "heartbeat" : "other"));
  const deps: ReconcileDeps = {
    cronSecret: SECRET,
    insertAudit,
    now: () => "2026-11-05T10:00:00.000Z",
    reconcilePayments: async () => void order.push("payments"),
    createMissingJobs: async () => void order.push("jobs"),
    sweepReservations: async () => (order.push("sweep"), sweepSummary),
    ...overrides,
  };
  return { deps, order };
}
const post = (headers: Record<string, string> = { authorization: `Bearer ${SECRET}`, "x-correlation-id": "corr-notify-1" }) =>
  new Request("http://localhost/api/cron/reconcile", { method: "POST", headers, body: "{}" });

describe("the notify step of the scheduled run", () => {
  it("runs last, after payments, jobs and the sweep, with the clock and correlation id", async () => {
    const { deps, order } = setup();
    const notify = vi.fn(async () => void order.push("notify"));
    const response = await handleReconcile(post(), { ...deps, notify });
    expect(response.status).toBe(200);
    expect(order).toEqual(["heartbeat", "payments", "jobs", "sweep", "notify"]);
    expect(notify).toHaveBeenCalledWith({ now: "2026-11-05T10:00:00.000Z", correlationId: "corr-notify-1" });
  });

  it("a failing notify step does not fail the run, and reveals nothing", async () => {
    const { deps } = setup();
    const response = await handleReconcile(post(), { ...deps, notify: async () => { throw new Error("provider said sam@example.com is bad"); } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("does not change the result codes of the other steps, and still runs after one of them failed", async () => {
    for (const [override, code] of [
      [{ reconcilePayments: async () => { throw new Error("x"); } }, "payments_failed"],
      [{ createMissingJobs: async () => { throw new Error("x"); } }, "jobs_failed"],
      [{ sweepReservations: async () => { throw new Error("x"); } }, "sweep_failed"],
    ] as const) {
      const notify = vi.fn(async () => void 0);
      const response = await handleReconcile(post(), { ...setup(override).deps, notify });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: code });
      expect(notify).toHaveBeenCalledTimes(1);
    }
  });

  it("is not run for an unauthorized request, and a run without it is unchanged", async () => {
    const notify = vi.fn(async () => void 0);
    expect((await handleReconcile(post({}), { ...setup().deps, notify })).status).toBe(401);
    expect(notify).not.toHaveBeenCalled();
    expect((await handleReconcile(post(), setup().deps)).status).toBe(200);
  });
});

describe("notifyBestEffort", () => {
  it("runs the pass and returns nothing", async () => {
    const run = vi.fn(async () => ({ sent: 1 }));
    await expect(notifyBestEffort(run)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("never lets a failure reach the caller", async () => {
    await expect(notifyBestEffort(async () => { throw new Error("database down"); })).resolves.toBeUndefined();
    await expect(notifyBestEffort(() => { throw new Error("thrown before a promise exists"); })).resolves.toBeUndefined();
  });
});
