import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import type { SweepSummary } from "@/lib/cron/reconcile-handler";
import { auditInsertFor } from "./shared";

export type SweepChange = {
  reservationId: string;
  kind: "expired" | "orphan" | "stale";
  from: string;
  to: string;
  reason: string;
};

export type SweepResult = SweepSummary & { changes: SweepChange[] };

type RpcChange = { reservation_id: string; kind: SweepChange["kind"]; from: string; to: string; reason: string };
type RpcError = { reservation_id: string; kind: SweepChange["kind"]; from: string; reason: string };

/**
 * One pass of the scheduled sweep. The database function decides and applies everything in one transaction: it releases
 * expired plain holds and holds of quotes that are no longer accepted, and sends stale or orphaned in-flight work to
 * review. It never releases anything in flight, awaiting confirmation, in review or committed. Each change is audited
 * (reservation id, states and reason only); a pass that changes nothing writes nothing.
 *
 * A hold whose stock cannot be given back (an accounting error) is left alone and does not stop the others. It is audited
 * as `reservation.sweep_error`, and after everything else is done this throws, so the scheduler shows the run as failed
 * until someone looks (the stock invariant check names the product).
 */
export async function sweepReservations(db: SupabaseClient, ctx: { now: string; correlationId: string }): Promise<SweepResult> {
  const rpc = await db.rpc("sweep_reservations", { p_now: ctx.now });
  if (rpc.error) throw new Error(`sweep_reservations: ${rpc.error.message}`);
  const result = rpc.data as { ok: boolean; code?: string; changes?: RpcChange[]; errors?: RpcError[] };
  if (!result.ok) throw new Error(`sweep_reservations refused: ${result.code}`);

  const changes: SweepChange[] = (result.changes ?? []).map((c) => ({
    reservationId: c.reservation_id,
    kind: c.kind,
    from: c.from,
    to: c.to,
    reason: c.reason,
  }));
  const errors = result.errors ?? [];

  const insertAudit = auditInsertFor(db);
  for (const c of changes) {
    await audit(insertAudit, {
      actor: "system:cron",
      action: c.to === "RELEASED" ? "reservation.released" : "reservation.flagged_for_review",
      entity: "reservation",
      entityId: c.reservationId,
      correlationId: ctx.correlationId,
      data: { reservation_id: c.reservationId, from: c.from, to: c.to, reason: c.reason },
    });
  }
  for (const e of errors) {
    await audit(insertAudit, {
      actor: "system:cron",
      action: "reservation.sweep_error",
      entity: "reservation",
      entityId: e.reservation_id,
      correlationId: ctx.correlationId,
      data: { reservation_id: e.reservation_id, from: e.from, reason: e.reason },
    });
  }
  if (errors.length > 0) throw new Error(`reservation sweep finished with ${errors.length} accounting error(s)`);

  return {
    expiredReleased: changes.filter((c) => c.kind === "expired").length,
    orphansReleased: changes.filter((c) => c.kind === "orphan" && c.to === "RELEASED").length,
    staleFlagged: changes.filter((c) => c.kind === "stale").length,
    orphansFlagged: changes.filter((c) => c.kind === "orphan" && c.to === "REVIEW_REQUIRED").length,
    changes,
  };
}
