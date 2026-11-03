import type { SupabaseClient } from "@supabase/supabase-js";
import { STUCK_AFTER_SECONDS, reconcileAttempt } from "./reconcile";
import { auditStep, type PaymentDeps, type ServiceContext } from "./shared";

const IN_FLIGHT = new Set(["AUTHORIZE_IN_FLIGHT", "CAPTURE_IN_FLIGHT", "VOID_IN_FLIGHT"]);
const ID = /^[A-Za-z0-9_-]{1,64}$/;

type EventRow = { id: string; processed_at: string | null; payment_attempt_id: string | null; payload: Record<string, unknown> };
type AttemptRef = { id: string; state: string; state_changed_at: string };

export type WebhookOutcome = "already" | "ignored" | "deferred" | "reconciled";

const text = (value: unknown): string | null => (typeof value === "string" && ID.test(value) ? value : null);

/**
 * Acts on a stored webhook event. The event is only a hint that something changed at PayPal: it names an order or an
 * authorization, we find our attempt from that, and the attempt is reconciled by asking PayPal. Nothing in the payload
 * (not its status, not its amount) is ever written as state, so a forged or stale event cannot move money or an attempt.
 * Because reconciliation reads PayPal's current state, a late or out-of-order event can never move an attempt backwards.
 *
 * Safe to call again for the same event: once processed it does nothing. An operation we started moments ago is left to
 * the code that is sending it (settling it from here could race that code); the scheduled reconcile catches it if it hangs.
 */
export async function applyWebhookEvent(db: SupabaseClient, deps: PaymentDeps, providerEventId: string, ctx: ServiceContext): Promise<WebhookOutcome> {
  const found = await db.from("payment_events").select("id, processed_at, payment_attempt_id, payload").eq("provider_event_id", providerEventId).maybeSingle();
  if (found.error) throw new Error(`load event: ${found.error.message}`);
  if (!found.data) throw new Error("webhook event is not stored");
  const event = found.data as EventRow;
  if (event.processed_at !== null) return "already";

  const attempt = await attemptFor(db, event.payload);
  const markProcessed = async () => {
    const { error } = await db.from("payment_events").update({ processed_at: ctx.now, ...(attempt ? { payment_attempt_id: attempt.id } : {}) }).eq("id", event.id).is("processed_at", null);
    if (error) throw new Error(`mark event processed: ${error.message}`);
  };

  if (!attempt) {
    await markProcessed(); // stored for the record, nothing of ours to act on
    return "ignored";
  }

  if (IN_FLIGHT.has(attempt.state) && Date.parse(ctx.now) - Date.parse(attempt.state_changed_at) < STUCK_AFTER_SECONDS * 1000) {
    await markProcessed();
    return "deferred";
  }

  const result = await reconcileAttempt(db, deps, attempt.id, { ...ctx, actor: ctx.actor ?? "system:webhook" });
  if (!result.ok) throw new Error(`reconcile after webhook: ${result.code}`);
  await markProcessed();
  if (result.value.changed) {
    await auditStep(db, ctx, "system:webhook", "payment.webhook_applied", attempt.id, { provider_event_id: providerEventId, from: attempt.state, to: result.value.state });
  }
  return "reconciled";
}

/** The attempt an event is about, found by the order or authorization id it names. Unknown ids find nothing. */
async function attemptFor(db: SupabaseClient, payload: Record<string, unknown>): Promise<AttemptRef | null> {
  const resourceId = text(payload.resource_id);
  const resourceType = typeof payload.resource_type === "string" ? payload.resource_type : "";
  const orderIds = [text(payload.order_id), resourceType === "checkout-order" ? resourceId : null].filter((v): v is string => v !== null);
  const authIds = [text(payload.authorization_id), resourceType === "authorization" ? resourceId : null].filter((v): v is string => v !== null);

  const select = "id, state, state_changed_at";
  if (orderIds.length > 0) {
    const byOrder = await db.from("payment_attempts").select(select).in("paypal_order_id", orderIds).order("created_at", { ascending: false }).limit(1);
    if (byOrder.error) throw new Error(`find attempt: ${byOrder.error.message}`);
    if (byOrder.data && byOrder.data.length > 0) return byOrder.data[0] as AttemptRef;
  }
  if (authIds.length > 0) {
    const byAuth = await db.from("payment_attempts").select(select).in("authorization_id", authIds).order("created_at", { ascending: false }).limit(1);
    if (byAuth.error) throw new Error(`find attempt: ${byAuth.error.message}`);
    if (byAuth.data && byAuth.data.length > 0) return byAuth.data[0] as AttemptRef;
  }
  return null;
}
