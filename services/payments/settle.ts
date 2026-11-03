import type { SupabaseClient } from "@supabase/supabase-js";
import type { BeginOperation, SettleOutcome } from "@/domain/payments";
import { callPay, type PayOut } from "./shared";

/** Begins a money-moving operation: the attempt and the reservation change together, or neither does. Nothing may be sent to PayPal unless this succeeds. */
export const beginPayment = (db: SupabaseClient, attemptId: string, operation: BeginOperation, now: string): Promise<PayOut> =>
  callPay(db, "payment_begin", { p_attempt_id: attemptId, p_operation: operation, p_now: now });

export type SettleArgs = {
  authorizationId?: string;
  authorizationExpiresAt?: string;
  captureId?: string;
  failureCode?: string;
  exceptionReason?: string;
  releaseReason?: "DECLINED" | "VOIDED";
  note?: string;
  holdMinutes?: number;
};

/** Settles the operation in flight with what PayPal's answer proved. The attempt, the reservation and the decision change in one transaction. */
export function settlePayment(db: SupabaseClient, attemptId: string, outcome: SettleOutcome, now: string, args: SettleArgs = {}): Promise<PayOut> {
  const rpc: Record<string, unknown> = { p_attempt_id: attemptId, p_outcome: outcome, p_now: now };
  if (args.authorizationId !== undefined) rpc.p_authorization_id = args.authorizationId;
  if (args.authorizationExpiresAt !== undefined) rpc.p_authorization_expires_at = args.authorizationExpiresAt;
  if (args.captureId !== undefined) rpc.p_capture_id = args.captureId;
  if (args.failureCode !== undefined) rpc.p_failure_code = args.failureCode;
  if (args.exceptionReason !== undefined) rpc.p_exception_reason = args.exceptionReason;
  if (args.releaseReason !== undefined) rpc.p_release_reason = args.releaseReason;
  if (args.note !== undefined) rpc.p_note = args.note;
  if (args.holdMinutes !== undefined) rpc.p_hold_minutes = args.holdMinutes;
  return callPay(db, "payment_settle", rpc);
}
