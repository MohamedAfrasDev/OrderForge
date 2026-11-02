import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReservationResult } from "@/domain/reservation";
import { audit } from "@/lib/audit";
import { actorOf, auditInsertFor, callRpc, failure, type ServiceContext } from "./shared";

/** A hold nobody is acting on. DECLINED and VOIDED can only come from a void settlement, never from here. */
export async function releaseHold(
  db: SupabaseClient,
  reservationId: string,
  reason: "EXPIRED" | "SUPERSEDED" | "ABANDONED",
  ctx: ServiceContext,
): Promise<ReservationResult<{ already: boolean }>> {
  const out = await callRpc(db, "release_hold", { p_reservation_id: reservationId, p_reason: reason, p_now: ctx.now });
  if (!out.ok) return failure(out);

  const already = out.already === true;
  if (!already) {
    await audit(auditInsertFor(db), {
      actor: actorOf(ctx),
      action: "reservation.released",
      entity: "reservation",
      entityId: reservationId,
      correlationId: ctx.correlationId,
      data: { reservation_id: reservationId, from: "HELD", to: "RELEASED", reason },
    });
  }
  return { ok: true, value: { already } };
}

/** Sends an in-flight or awaiting reservation to a person, with the reason. Its stock stays held. */
export async function flagForReview(
  db: SupabaseClient,
  reservationId: string,
  reason: string,
  ctx: ServiceContext,
): Promise<ReservationResult<{ already: boolean }>> {
  const out = await callRpc(db, "flag_for_review", { p_reservation_id: reservationId, p_reason: reason, p_now: ctx.now });
  if (!out.ok) return failure(out);

  const already = out.already === true;
  if (!already) {
    await audit(auditInsertFor(db), {
      actor: actorOf(ctx),
      action: "reservation.flagged_for_review",
      entity: "reservation",
      entityId: reservationId,
      correlationId: ctx.correlationId,
      data: { reservation_id: reservationId, to: "REVIEW_REQUIRED", reason: reason.trim() },
    });
  }
  return { ok: true, value: { already } };
}

export type Invalidated = { released: number; flagged: number; skipped: number };

/**
 * `quote-approval` reports the purchases it invalidated when a newer quote replaces an accepted one. Their holds
 * must not outlive the quote: a plain hold is released (SUPERSEDED); an in-flight or awaiting one goes to review,
 * because money may be involved; anything else needs nothing. The sweep catches whatever this misses, so a failure
 * here is never fatal to publishing.
 */
export async function releaseForInvalidatedPurchases(
  db: SupabaseClient,
  purchaseIds: readonly string[],
  ctx: ServiceContext,
): Promise<ReservationResult<Invalidated>> {
  const unique = [...new Set(purchaseIds)];
  if (unique.length === 0) return { ok: true, value: { released: 0, flagged: 0, skipped: 0 } };

  const found = await db.from("reservations").select("id, purchase_id, state").in("purchase_id", unique);
  if (found.error) throw new Error(`load reservations: ${found.error.message}`);
  const byPurchase = new Map((found.data ?? []).map((r) => [r.purchase_id as string, r as { id: string; state: string }]));

  const FLAG_REASON = "quote is no longer accepted";
  let released = 0;
  let flagged = 0;
  let skipped = 0;

  for (const purchaseId of unique) {
    const reservation = byPurchase.get(purchaseId);
    if (!reservation) {
      skipped++;
      continue;
    }

    let needsFlag = reservation.state === "PAYMENT_IN_FLIGHT" || reservation.state === "AWAITING_CONFIRMATION";
    if (reservation.state === "HELD") {
      const r = await releaseHold(db, reservation.id, "SUPERSEDED", ctx);
      if (r.ok) {
        if (!r.value.already) released++;
        else skipped++;
        continue;
      }
      // It moved into flight between listing and releasing: treat it like any in-flight reservation.
      needsFlag = r.code === "OPERATION_IN_FLIGHT" || r.code === "NOT_HELD";
      if (!needsFlag) throw new Error(`release for invalidated purchase failed: ${r.code}`);
    }

    if (needsFlag) {
      const f = await flagForReview(db, reservation.id, FLAG_REASON, ctx);
      if (f.ok && !f.value.already) flagged++;
      else if (f.ok || f.code === "ILLEGAL_TRANSITION") skipped++;
      else throw new Error(`flag for review failed: ${f.code}`);
    } else {
      skipped++;
    }
  }

  return { ok: true, value: { released, flagged, skipped } };
}
