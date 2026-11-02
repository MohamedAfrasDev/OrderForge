import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaymentErrorCode } from "@/domain/payments";
import { audit } from "@/lib/audit";
import type { PayPalClient } from "@/lib/paypal/client";
import { auditInsertFor, type ServiceContext } from "@/services/reservation/shared";

export type { ServiceContext };

/** The part of the PayPal client payments uses. Tests hand in a client pointed at the local fake. */
export type PayPalPort = Pick<PayPalClient, "createOrder" | "authorizeOrder" | "getOrder">;

export type EvidenceLabel = "mocked" | "replayed" | "real-sandbox";

/** What a payments service needs besides the database: PayPal, and how to label the evidence it stores. */
export type PaymentDeps = { paypal: PayPalPort; evidence: EvidenceLabel };

export type PayOut = {
  ok: boolean;
  code?: PaymentErrorCode | "OPERATION_IN_FLIGHT";
  already?: boolean;
  attempt_id?: string;
  state?: string;
  reservation_code?: string;
  [key: string]: unknown;
};

export async function callPay(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<PayOut> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as PayOut;
}

/** The payload keys a stored payment event may carry. Anything else (payer details, links, raw bodies) is dropped. */
const EVENT_KEYS = ["order_id", "authorization_id", "amount_minor", "currency", "status", "request_id", "outcome"] as const;

export async function recordEvent(
  db: SupabaseClient,
  deps: PaymentDeps,
  attemptId: string,
  eventType: string,
  source: "api" | "reconcile",
  summary: Partial<Record<(typeof EVENT_KEYS)[number], string | number>>,
): Promise<void> {
  const payload: Record<string, string | number> = {};
  for (const key of EVENT_KEYS) {
    const value = summary[key];
    if (value !== undefined) payload[key] = value;
  }
  const { error } = await db.from("payment_events").insert({
    payment_attempt_id: attemptId,
    event_type: eventType,
    source,
    evidence_label: deps.evidence,
    payload,
  });
  if (error) throw new Error(`payment event: ${error.message}`);
}

export async function auditStep(
  db: SupabaseClient,
  ctx: ServiceContext,
  actor: string,
  action: string,
  attemptId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await audit(auditInsertFor(db), {
    actor: ctx.actor ?? actor,
    action,
    entity: "payment_attempt",
    entityId: attemptId,
    correlationId: ctx.correlationId,
    data: { payment_attempt_id: attemptId, ...data },
  });
}

/** PayPal's own reason for a refusal as a short stable code, for the attempt's failure_code. */
export function failureCodeOf(result: { issues: string[]; errorName?: string }): string {
  const raw = result.issues[0] ?? result.errorName ?? "PROVIDER_REFUSED";
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "PROVIDER_REFUSED";
}


/** A refused RPC's code as a payments error code (an operation already in flight means the attempt is active). */
export function refusalCode(out: PayOut, fallback: PaymentErrorCode): PaymentErrorCode {
  if (out.code === "OPERATION_IN_FLIGHT") return "ATTEMPT_ACTIVE";
  return out.code ?? fallback;
}
