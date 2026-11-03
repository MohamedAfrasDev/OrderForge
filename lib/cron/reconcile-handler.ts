import { createHash, timingSafeEqual } from "node:crypto";
import { audit, type AuditInsert } from "@/lib/audit";
import { correlationIdFrom } from "@/lib/correlation";

/** What one reservation sweep changed. Counts only; the details are audited per reservation by the sweep itself. */
export type SweepSummary = {
  expiredReleased: number;
  orphansReleased: number;
  staleFlagged: number;
  orphansFlagged: number;
};

export type ReconcileDeps = {
  cronSecret: string;
  insertAudit: AuditInsert;
  /** Payments reconciliation. Runs after the heartbeat and before the sweep; its failure never stops the sweep. */
  reconcilePayments?: (context: { now: string; correlationId: string }) => Promise<unknown>;
  /** Creates the job of every paid purchase that lacks one. Runs after payments and before the sweep; its failure never stops the sweep. */
  createMissingJobs?: (context: { now: string; correlationId: string }) => Promise<unknown>;
  /** Runs after the heartbeat. The reservation module supplies it; omitted, a run is just the heartbeat. */
  sweepReservations?: (context: { now: string; correlationId: string }) => Promise<SweepSummary>;
  /** The clock, injectable for tests. */
  now?: () => string;
};

const reply = (body: Record<string, string>, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time check of "Authorization: Bearer <secret>". An unset server secret authorizes nobody. */
function isAuthorized(header: string | null, secret: string): boolean {
  if (!secret) return false;
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) return false;
  // Hash both sides so the comparison is the same length whatever the caller sends.
  return timingSafeEqual(digest(match[1]), digest(secret));
}

/** The record a reconcile run leaves behind. Shared by the scheduled route and the manual button. */
export async function recordReconcileHeartbeat(
  insertAudit: AuditInsert,
  input: { actor: string; correlationId: string },
): Promise<void> {
  await audit(insertAudit, {
    actor: input.actor,
    action: "reconcile.heartbeat",
    entity: "system",
    entityId: "reconcile",
    correlationId: input.correlationId,
    data: { status: "ok" },
  });
}

/**
 * Entry point for the scheduled reconcile job (Supabase pg_cron -> pg_net -> this route).
 * Foundation only records a heartbeat; the payments module adds the real reconciliation here.
 * Safe to call repeatedly and concurrently: a run has no effect beyond one audit row.
 */
export async function handleReconcile(request: Request, deps: ReconcileDeps): Promise<Response> {
  if (!isAuthorized(request.headers.get("authorization"), deps.cronSecret)) {
    return reply({ error: "unauthorized" }, 401);
  }

  const correlationId = correlationIdFrom(request.headers);
  try {
    await recordReconcileHeartbeat(deps.insertAudit, { actor: "system:cron", correlationId });
  } catch {
    // A non-2xx shows up in the scheduler's run history. Nothing about the cause is returned.
    return reply({ error: "heartbeat_failed" }, 500);
  }

  const context = { now: (deps.now ?? (() => new Date().toISOString()))(), correlationId };
  let failure: "payments_failed" | "jobs_failed" | "sweep_failed" | null = null;

  if (deps.reconcilePayments) {
    try {
      await deps.reconcilePayments(context);
    } catch {
      // Remembered, not returned yet: the sweep still runs, then the run fails visibly. The cause is never revealed.
      failure = "payments_failed";
    }
  }
  if (deps.createMissingJobs) {
    try {
      await deps.createMissingJobs(context);
    } catch {
      failure ??= "jobs_failed";
    }
  }
  if (deps.sweepReservations) {
    try {
      await deps.sweepReservations(context);
    } catch {
      // The heartbeat is already recorded. A failed sweep must be visible to the scheduler, and reveals nothing else.
      failure ??= "sweep_failed";
    }
  }
  if (failure) return reply({ error: failure }, 500);
  return reply({ status: "ok" }, 200);
}
