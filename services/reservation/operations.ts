import type { SupabaseClient } from "@supabase/supabase-js";
import type { Operation, ReleaseReason, ReservationResult, SettleOutcome } from "@/domain/reservation";
import { audit } from "@/lib/audit";
import { actorOf, auditInsertFor, callRpc, failure, holdMinutesFor, merchantOfReservation, type ServiceContext } from "./shared";

/**
 * Payments calls this BEFORE any PayPal request that could move money. If it returns a failure, nothing may be sent.
 * `OPERATION_IN_FLIGHT` means another caller owns the operation; `HOLD_EXPIRED` means the hold ran out and was released
 * here, so the customer must start again.
 */
export async function beginOperation(
  db: SupabaseClient,
  reservationId: string,
  operation: Operation,
  ctx: ServiceContext,
): Promise<ReservationResult<{ operation: Operation }>> {
  const out = await callRpc(db, "begin_operation", { p_reservation_id: reservationId, p_operation: operation, p_now: ctx.now });
  const insertAudit = auditInsertFor(db);

  if (!out.ok) {
    if (out.code === "HOLD_EXPIRED") {
      await audit(insertAudit, {
        actor: actorOf(ctx),
        action: "reservation.released",
        entity: "reservation",
        entityId: reservationId,
        correlationId: ctx.correlationId,
        data: { reservation_id: reservationId, from: "HELD", to: "RELEASED", reason: "EXPIRED" },
      });
    }
    return failure(out);
  }

  await audit(insertAudit, {
    actor: actorOf(ctx),
    action: "reservation.operation_begun",
    entity: "reservation",
    entityId: reservationId,
    correlationId: ctx.correlationId,
    data: { reservation_id: reservationId, to: "PAYMENT_IN_FLIGHT", operation },
  });
  return { ok: true, value: { operation } };
}

export type SettleOptions = {
  /** For a void: why the stock is released. DECLINED when the merchant declined, VOIDED otherwise (the default). */
  releaseReason?: Extract<ReleaseReason, "DECLINED" | "VOIDED">;
  /** For an UNKNOWN outcome: what was uncertain, kept with the reservation for whoever resolves it. */
  note?: string;
};

/**
 * Payments calls this after definitive evidence of what happened. The outcome must fit the operation that was begun.
 * CAPTURED commits stock, VOIDED releases it, a failure returns to the earlier state, and UNKNOWN sends the reservation
 * to a person with its stock still held. Repeating a success outcome is a no-op (and is not audited again).
 */
export async function settleOperation(
  db: SupabaseClient,
  reservationId: string,
  outcome: SettleOutcome,
  ctx: ServiceContext,
  options: SettleOptions = {},
): Promise<ReservationResult<{ state: string; already: boolean }>> {
  const args: Record<string, unknown> = { p_reservation_id: reservationId, p_outcome: outcome, p_now: ctx.now };
  if (outcome === "AUTHORIZE_FAILED") {
    const merchantId = await merchantOfReservation(db, reservationId);
    if (merchantId) args.p_hold_minutes = await holdMinutesFor(db, merchantId);
  }
  if (options.releaseReason) args.p_release_reason = options.releaseReason;
  if (options.note) args.p_reason = options.note;

  const out = await callRpc(db, "settle_operation", args);
  if (!out.ok) return failure(out);

  const already = out.already === true;
  if (!already) {
    await audit(auditInsertFor(db), {
      actor: actorOf(ctx),
      action: "reservation.settled",
      entity: "reservation",
      entityId: reservationId,
      correlationId: ctx.correlationId,
      data: { reservation_id: reservationId, to: out.state, status: outcome },
    });
  }
  return { ok: true, value: { state: out.state!, already } };
}

/**
 * A person (or reconciliation) resolves a reservation that was sent to review, with evidence of what really happened.
 * The actor goes in the audit trail. A resolution back to HELD restarts the hold with the merchant's window.
 */
export async function resolveReview(
  db: SupabaseClient,
  reservationId: string,
  target: "HELD" | "AWAITING_CONFIRMATION" | "COMMITTED" | "RELEASED",
  evidence: string,
  ctx: ServiceContext,
  options: { releaseReason?: ReleaseReason } = {},
): Promise<ReservationResult<{ state: string; already: boolean }>> {
  const args: Record<string, unknown> = { p_reservation_id: reservationId, p_target: target, p_evidence: evidence, p_now: ctx.now };
  if (target === "HELD") {
    const merchantId = await merchantOfReservation(db, reservationId);
    if (merchantId) args.p_hold_minutes = await holdMinutesFor(db, merchantId);
  }
  if (options.releaseReason) args.p_release_reason = options.releaseReason;

  const out = await callRpc(db, "resolve_review", args);
  if (!out.ok) return failure(out);

  const already = out.already === true;
  if (!already) {
    await audit(auditInsertFor(db), {
      actor: actorOf(ctx),
      action: "reservation.review_resolved",
      entity: "reservation",
      entityId: reservationId,
      correlationId: ctx.correlationId,
      data: { reservation_id: reservationId, from: "REVIEW_REQUIRED", to: target, reason: evidence.trim() },
    });
  }
  return { ok: true, value: { state: out.state!, already } };
}
