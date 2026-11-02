import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ReservationErrorCode, ReservationResult, Shortage } from "@/domain/reservation";
import type { AuditInsert } from "@/lib/audit";

/**
 * `now` and `correlationId` are passed in by the caller (route, action or payments); services never read the clock.
 * `actor` names who is acting in the audit trail ("system" when omitted; payments uses "system:payments", a merchant
 * "merchant:<user id>").
 */
export type ServiceContext = { now: string; correlationId: string; actor?: string };

export const actorOf = (ctx: ServiceContext): string => ctx.actor ?? "system";

export function auditInsertFor(db: SupabaseClient): AuditInsert {
  return async (row) => {
    const { error } = await db.from("audit_events").insert(row);
    if (error) throw new Error(`audit insert: ${error.message}`);
  };
}

export const DEFAULT_HOLD_MINUTES = 30;
const holdRuleSchema = z.strictObject({ minutes: z.number().int().min(1).max(1440) });

/** The merchant rule `reservation_hold_minutes` ({ "minutes": 30 }); 30 when the merchant has not set one. */
export async function holdMinutesFor(db: SupabaseClient, merchantId: string): Promise<number> {
  const { data, error } = await db
    .from("business_rules")
    .select("value")
    .eq("merchant_id", merchantId)
    .eq("key", "reservation_hold_minutes")
    .maybeSingle();
  if (error) throw new Error(`load reservation_hold_minutes: ${error.message}`);
  if (!data) return DEFAULT_HOLD_MINUTES;
  const parsed = holdRuleSchema.safeParse(data.value);
  if (!parsed.success) throw new Error('business rule "reservation_hold_minutes" is malformed');
  return parsed.data.minutes;
}

/** The merchant a reservation belongs to (through its purchase), or null when there is no such reservation. */
export async function merchantOfReservation(db: SupabaseClient, reservationId: string): Promise<string | null> {
  const found = await db.from("reservations").select("purchases!inner(merchant_id)").eq("id", reservationId).maybeSingle();
  if (found.error) throw new Error(`load reservation: ${found.error.message}`);
  if (!found.data) return null;
  const purchase = (found.data as unknown as { purchases: { merchant_id: string } | { merchant_id: string }[] }).purchases;
  return (Array.isArray(purchase) ? purchase[0]! : purchase).merchant_id;
}

export type RpcOut = {
  ok: boolean;
  code?: ReservationErrorCode;
  already?: boolean;
  reheld?: boolean;
  reservation_id?: string;
  expires_at?: string;
  state?: string;
  operation?: string;
  shortages?: Array<{ product_id: string; needed: number; available: number }>;
};

export async function callRpc(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<RpcOut> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as RpcOut;
}

/** The coded failure for a refused RPC, with shortages in the shape the rest of the code uses. */
export function failure(out: RpcOut): Extract<ReservationResult<never>, { ok: false }> {
  const shortages: Shortage[] | undefined = out.shortages?.map((s) => ({ productId: s.product_id, needed: s.needed, available: s.available }));
  return { ok: false, code: out.code!, ...(shortages ? { shortages } : {}) };
}
