import type { SupabaseClient } from "@supabase/supabase-js";
import { createChain, must, type Chain } from "./helpers";

export const T0 = "2026-11-03T10:00:00.000Z";

export type PayOut = {
  ok: boolean;
  code?: string;
  already?: boolean;
  attempt_id?: string;
  state?: string;
  [key: string]: unknown;
};

export async function pay(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<PayOut> {
  return must(await db.rpc(fn, args), fn) as PayOut;
}

export const AMOUNT = 108000;

/** A purchase whose approval carries `chain.quoteHash` and whose quote total is 108000, ready for a payment attempt. */
export async function newPurchase(db: SupabaseClient): Promise<Chain> {
  return createChain(db);
}

export const createAttempt = (db: SupabaseClient, chain: Chain, over: Record<string, unknown> = {}) =>
  pay(db, "payment_create_attempt", { p_purchase_id: chain.purchaseId, p_amount_minor: AMOUNT, p_quote_hash: chain.quoteHash, p_now: T0, ...over });

export const recordOrder = (db: SupabaseClient, attemptId: string, orderId: string, approveUrl: string | null = "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1", now = T0) =>
  pay(db, "payment_record_order", { p_attempt_id: attemptId, p_order_id: orderId, p_approve_url: approveUrl, p_now: now });

export const markApproved = (db: SupabaseClient, attemptId: string, now = T0) => pay(db, "payment_mark_approved", { p_attempt_id: attemptId, p_now: now });

export const failAttempt = (db: SupabaseClient, attemptId: string, code = "ORDER_REFUSED", now = T0) =>
  pay(db, "payment_fail", { p_attempt_id: attemptId, p_failure_code: code, p_now: now });

export async function attemptRow(db: SupabaseClient, attemptId: string) {
  return must(
    await db
      .from("payment_attempts")
      .select("state, paypal_order_id, approve_url, authorization_id, capture_id, unknown_operation, failure_code, exception_reason, state_changed_at, amount_minor, currency, quote_hash")
      .eq("id", attemptId)
      .single(),
    "attempt",
  ) as {
    state: string;
    paypal_order_id: string | null;
    approve_url: string | null;
    authorization_id: string | null;
    capture_id: string | null;
    unknown_operation: string | null;
    failure_code: string | null;
    exception_reason: string | null;
    state_changed_at: string;
    amount_minor: number;
    currency: string;
    quote_hash: string;
  };
}
