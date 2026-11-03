import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyAuthorization, verifyCapture, type PaymentResult } from "@/domain/payments";
import { resumeDecision } from "./decide";
import { settlePayment } from "./settle";
import { auditStep, callPay, recordEvent, type PaymentDeps, type ServiceContext } from "./shared";

/** An operation in flight this long without an answer is treated as stuck (spec assumption 8). */
export const STUCK_AFTER_SECONDS = 120;
/** The most attempts one scheduled run looks at. */
export const BATCH_LIMIT = 20;

const IN_FLIGHT = ["AUTHORIZE_IN_FLIGHT", "CAPTURE_IN_FLIGHT", "VOID_IN_FLIGHT"] as const;
const PRE_AUTH = ["CREATED", "PROVIDER_CREATED", "APPROVED"] as const;

type AttemptRow = {
  id: string;
  purchase_id: string;
  state: string;
  amount_minor: number;
  currency: "USD";
  paypal_order_id: string | null;
  authorization_id: string | null;
  authorization_expires_at: string | null;
  unknown_operation: string | null;
  state_changed_at: string;
};
const COLUMNS = "id, purchase_id, state, amount_minor, currency, paypal_order_id, authorization_id, authorization_expires_at, unknown_operation, state_changed_at";

export type Reconciled = { state: string; changed: boolean };

async function load(db: SupabaseClient, attemptId: string): Promise<AttemptRow | null> {
  const found = await db.from("payment_attempts").select(COLUMNS).eq("id", attemptId).maybeSingle();
  if (found.error) throw new Error(`load attempt: ${found.error.message}`);
  return (found.data as AttemptRow | null) ?? null;
}

const ACTOR = "system:cron";

/**
 * Asks PayPal what really happened to one attempt and brings the record in line. This is the only way out of
 * OUTCOME_UNKNOWN, and it never sends a money-moving request: it only reads. Whatever PayPal cannot answer leaves the
 * attempt exactly as it was (still in doubt), and anything PayPal's records contradict becomes a financial exception.
 */
export async function reconcileAttempt(db: SupabaseClient, deps: PaymentDeps, attemptId: string, ctx: ServiceContext): Promise<PaymentResult<Reconciled>> {
  const attempt = await load(db, attemptId);
  if (!attempt) return { ok: false, code: "NOT_FOUND" };
  const before = attempt.state;
  const done = async (): Promise<PaymentResult<Reconciled>> => {
    const after = await load(db, attemptId);
    return { ok: true, value: { state: after!.state, changed: after!.state !== before } };
  };

  if ((IN_FLIGHT as readonly string[]).includes(attempt.state)) {
    // An operation begun moments ago belongs to the code that is sending it, which settles it when PayPal answers. Putting it in
    // doubt from here would make that settle fail and could record "not done" for a request PayPal is still processing (seen on
    // the real sandbox: a webhook arrived 1.4 seconds after the authorize began). Only a stuck operation is reconciled.
    if (Date.parse(ctx.now) - Date.parse(attempt.state_changed_at) < STUCK_AFTER_SECONDS * 1000) return done();
    // The answer never came back to us. Put it in doubt properly, then resolve it with PayPal's records.
    const op = attempt.state === "AUTHORIZE_IN_FLIGHT" ? "authorize" : attempt.state === "CAPTURE_IN_FLIGHT" ? "capture" : "void";
    const marked = await settlePayment(db, attemptId, "UNKNOWN", ctx.now, { note: `${op} outcome unknown: no answer recorded` });
    if (!marked.ok) return { ok: false, code: "ILLEGAL_TRANSITION", cause: marked.code };
    return resolveUnknown(db, deps, attemptId, op, ctx, before, done);
  }
  if (attempt.state === "OUTCOME_UNKNOWN") {
    const op = attempt.unknown_operation as "authorize" | "capture" | "void" | null;
    if (!op) return { ok: false, code: "ILLEGAL_TRANSITION", cause: "no uncertain operation recorded" };
    return resolveUnknown(db, deps, attemptId, op, ctx, before, done);
  }
  if ((PRE_AUTH as readonly string[]).includes(attempt.state)) return reconcilePreAuthorization(db, deps, attempt, ctx, done);
  if (attempt.state === "AUTHORIZED") return reconcileAuthorized(db, deps, attempt, ctx, done);
  return done();
}

type Done = () => Promise<PaymentResult<Reconciled>>;

async function resolveUnknown(
  db: SupabaseClient,
  deps: PaymentDeps,
  attemptId: string,
  op: "authorize" | "capture" | "void",
  ctx: ServiceContext,
  from: string,
  done: Done,
): Promise<PaymentResult<Reconciled>> {
  const attempt = (await load(db, attemptId))!;
  const stay = async (why: string) => {
    await auditStep(db, ctx, ACTOR, "payment.reconcile_pending", attemptId, { operation: op, reason: why, state: attempt.state });
    return done();
  };
  const resolve = async (resolution: string, args: Record<string, unknown>, event: string, summary: Parameters<typeof recordEvent>[5]) => {
    const out = await callPay(db, "payment_resolve_unknown", { p_attempt_id: attemptId, p_resolution: resolution, p_now: ctx.now, ...args });
    if (!out.ok) return { ok: false as const, code: "ILLEGAL_TRANSITION" as const, cause: String(out.code) };
    await recordEvent(db, deps, attemptId, event, "reconcile", summary);
    await auditStep(db, ctx, ACTOR, "payment.reconciled", attemptId, { from, to: out.state, operation: op, reason: resolution });
    return done();
  };
  const exception = (reason: string, extra: Record<string, unknown> = {}) =>
    resolve("EXCEPTION", { p_exception_reason: reason, ...extra }, "payment.reconcile_exception", { outcome: reason });

  if (attempt.paypal_order_id === null) return stay("no order on record");

  if (op === "authorize") {
    const order = await deps.paypal.getOrder(attempt.paypal_order_id);
    if (order.kind !== "ok") return stay("PayPal could not be read");
    if (order.data.authorizationId) {
      const auth = await deps.paypal.getAuthorization(order.data.authorizationId);
      if (auth.kind !== "ok") return stay("authorization could not be read");
      const verification = verifyAuthorization(
        { amountMinor: attempt.amount_minor, currency: attempt.currency, paypalOrderId: attempt.paypal_order_id, authorizationId: null },
        { orderId: order.data.id, authorizationId: auth.data.id, authorizationStatus: auth.data.status, amountMinor: auth.data.amountMinor, currency: auth.data.currency },
      );
      if (!verification.ok) return exception(verification.exception, { p_authorization_id: auth.data.id });
      return resolve(
        "AUTHORIZED",
        { p_authorization_id: auth.data.id, ...(auth.data.expirationTime ? { p_authorization_expires_at: auth.data.expirationTime } : {}) },
        "payment.reconciled_authorized",
        { order_id: attempt.paypal_order_id, authorization_id: auth.data.id, status: auth.data.status },
      );
    }
    if (order.data.status === "APPROVED") {
      return resolve("APPROVED", {}, "payment.reconciled_not_done", { order_id: attempt.paypal_order_id, status: order.data.status, outcome: "authorize not done" });
    }
    if (order.data.status === "VOIDED" || order.data.status === "EXPIRED") {
      return resolve("FAILED", { p_failure_code: `ORDER_${order.data.status}` }, "payment.reconciled_failed", { order_id: attempt.paypal_order_id, status: order.data.status });
    }
    return stay(`order is ${order.data.status}`);
  }

  if (attempt.authorization_id === null) return stay("no authorization on record");
  const auth = await deps.paypal.getAuthorization(attempt.authorization_id);
  if (auth.kind !== "ok") return stay("authorization could not be read");
  const status = auth.data.status;

  if (op === "capture") {
    if (status === "CAPTURED" || status === "PARTIALLY_CAPTURED") {
      const order = await deps.paypal.getOrder(attempt.paypal_order_id);
      if (order.kind !== "ok") return stay("order could not be read");
      if (!order.data.captureId) return exception("EVIDENCE_MISSING");
      const capture = await deps.paypal.getCapture(order.data.captureId);
      if (capture.kind !== "ok") return stay("capture could not be read");
      const verification = verifyCapture(
        { amountMinor: attempt.amount_minor, currency: attempt.currency, paypalOrderId: attempt.paypal_order_id, authorizationId: attempt.authorization_id },
        { id: order.data.id, authorizationId: order.data.authorizationId, captureId: order.data.captureId },
        { captureId: capture.data.captureId, status: capture.data.status, amountMinor: capture.data.amountMinor, currency: capture.data.currency },
        deps.payeeMerchantId === undefined ? undefined : { expected: deps.payeeMerchantId, actual: order.data.payeeMerchantId ?? null },
      );
      if (!verification.ok) return exception(verification.exception, { p_capture_id: capture.data.captureId });
      return resolve("CAPTURED", { p_capture_id: capture.data.captureId }, "payment.reconciled_captured", {
        order_id: attempt.paypal_order_id,
        authorization_id: attempt.authorization_id,
        amount_minor: capture.data.amountMinor ?? 0,
        currency: capture.data.currency ?? "",
        status: capture.data.status,
      });
    }
    if (status === "CREATED") {
      return resolve("AUTHORIZED", {}, "payment.reconciled_not_done", { authorization_id: attempt.authorization_id, status, outcome: "capture not done" });
    }
    return exception("STATUS_NOT_AS_EXPECTED");
  }

  // void
  if (status === "VOIDED") {
    return resolve("VOIDED", { p_release_reason: "DECLINED" }, "payment.reconciled_voided", { authorization_id: attempt.authorization_id, status });
  }
  if (status === "CREATED") {
    return resolve("AUTHORIZED", {}, "payment.reconciled_not_done", { authorization_id: attempt.authorization_id, status, outcome: "void not done" });
  }
  // Captured (or anything else) while we were trying to void: money moved. A person decides.
  return exception("STATUS_NOT_AS_EXPECTED");
}

/** Before authorization: learn what PayPal says about the order, then end the attempt if its hold has run out. */
async function reconcilePreAuthorization(db: SupabaseClient, deps: PaymentDeps, attempt: AttemptRow, ctx: ServiceContext, done: Done): Promise<PaymentResult<Reconciled>> {
  if (attempt.paypal_order_id) {
    const order = await deps.paypal.getOrder(attempt.paypal_order_id);
    if (order.kind === "ok") {
      if (order.data.status === "VOIDED" || order.data.status === "EXPIRED") {
        const failed = await callPay(db, "payment_fail", { p_attempt_id: attempt.id, p_failure_code: `ORDER_${order.data.status}`, p_now: ctx.now });
        if (failed.ok) {
          await auditStep(db, ctx, ACTOR, "payment.reconciled", attempt.id, { from: attempt.state, to: "FAILED", reason: `ORDER_${order.data.status}` });
          return done();
        }
      }
      if (order.data.status === "APPROVED" && attempt.state === "PROVIDER_CREATED") {
        const marked = await callPay(db, "payment_mark_approved", { p_attempt_id: attempt.id, p_now: ctx.now });
        if (marked.ok) await auditStep(db, ctx, ACTOR, "payment.reconciled", attempt.id, { from: "PROVIDER_CREATED", to: "APPROVED" });
      }
    }
  }
  // payment_expire refuses while the hold is still running; that is simply "not yet".
  const expired = await callPay(db, "payment_expire", { p_attempt_id: attempt.id, p_evidence: "the hold ran out before the payment was authorized", p_now: ctx.now });
  if (expired.ok && !expired.already) await auditStep(db, ctx, ACTOR, "payment.expired", attempt.id, { from: attempt.state, to: "EXPIRED" });
  return done();
}

/** An authorization waiting for the merchant: past the expiry PayPal gave, confirm with PayPal, then expire it. */
async function reconcileAuthorized(db: SupabaseClient, deps: PaymentDeps, attempt: AttemptRow, ctx: ServiceContext, done: Done): Promise<PaymentResult<Reconciled>> {
  if (attempt.authorization_expires_at === null || Date.parse(ctx.now) < Date.parse(attempt.authorization_expires_at) || attempt.authorization_id === null) return done();
  const auth = await deps.paypal.getAuthorization(attempt.authorization_id);
  if (auth.kind !== "ok") return done();
  if (auth.data.status === "CAPTURED" || auth.data.status === "PARTIALLY_CAPTURED" || auth.data.status === "VOIDED") return done(); // money moved elsewhere: not ours to expire
  const expired = await callPay(db, "payment_expire", { p_attempt_id: attempt.id, p_evidence: `PayPal authorization ${auth.data.status} past its expiry`, p_now: ctx.now });
  if (expired.ok && !expired.already) {
    await recordEvent(db, deps, attempt.id, "payment.authorization_expired", "reconcile", { authorization_id: attempt.authorization_id, status: auth.data.status });
    await auditStep(db, ctx, ACTOR, "payment.expired", attempt.id, { from: "AUTHORIZED", to: "EXPIRED" });
  }
  return done();
}

export type ReconcileSummary = { checked: number; settled: number; stillUnknown: number; errors: number };

/**
 * One scheduled pass. Looks at stuck operations (in flight for STUCK_AFTER_SECONDS or more), unknown outcomes, attempts
 * that never got past order creation, idle pre-authorization attempts and authorizations past their expiry: at most
 * BATCH_LIMIT, oldest first. Each attempt is isolated, so one failure never stops the rest; after everything else is
 * done, a run with errors throws so the scheduler shows it as failed. Capture or void that reconciliation found "not
 * done" is carried out again with its stable request id.
 */
export async function reconcilePayments(
  db: SupabaseClient,
  deps: PaymentDeps,
  ctx: ServiceContext,
  options: { attemptIds?: readonly string[] } = {},
): Promise<ReconcileSummary> {
  const stuckBefore = new Date(Date.parse(ctx.now) - STUCK_AFTER_SECONDS * 1000).toISOString();
  const ids: string[] = [];
  const add = (rows: Array<{ id: string }> | null) => {
    for (const r of rows ?? []) if (!ids.includes(r.id)) ids.push(r.id);
  };
  const only = options.attemptIds ? [...options.attemptIds] : null;
  const q = async (build: (t: ReturnType<SupabaseClient["from"]>) => PromiseLike<{ data: Array<{ id: string }> | null; error: { message: string } | null }>) => {
    const { data, error } = await build(db.from("payment_attempts"));
    if (error) throw new Error(`reconcile query: ${error.message}`);
    add(data);
  };

  const scoped = <T extends { in: (c: string, v: string[]) => T }>(query: T): T => (only ? query.in("id", only) : query);

  await q((t) => scoped(t.select("id").eq("state", "OUTCOME_UNKNOWN").order("state_changed_at").limit(BATCH_LIMIT)));
  await q((t) => scoped(t.select("id").in("state", [...IN_FLIGHT]).lte("state_changed_at", stuckBefore).order("state_changed_at").limit(BATCH_LIMIT)));
  await q((t) => scoped(t.select("id").eq("state", "AUTHORIZED").lte("authorization_expires_at", ctx.now).order("authorization_expires_at").limit(BATCH_LIMIT)));
  await q((t) => scoped(t.select("id").in("state", [...PRE_AUTH]).lte("state_changed_at", stuckBefore).order("state_changed_at").limit(BATCH_LIMIT)));

  const batch = ids.slice(0, BATCH_LIMIT);
  const summary: ReconcileSummary = { checked: 0, settled: 0, stillUnknown: 0, errors: 0 };
  for (const id of batch) {
    summary.checked += 1;
    try {
      const result = await reconcileAttempt(db, deps, id, ctx);
      if (!result.ok) {
        summary.errors += 1;
        continue;
      }
      let state = result.value.state;
      if (result.value.changed) summary.settled += 1;
      if (result.value.changed && state === "AUTHORIZED") {
        // A capture or void that never happened is carried out again, with the same request id.
        const resumed = await resumeDecision(db, deps, id, ctx);
        if (resumed.ok) state = resumed.value.state;
      }
      if (state === "OUTCOME_UNKNOWN") summary.stillUnknown += 1;
    } catch (error) {
      summary.errors += 1;
      try {
        await auditStep(db, ctx, ACTOR, "payment.reconcile_error", id, { reason: error instanceof Error ? error.message.slice(0, 150) : "error" });
      } catch {
        // The audit itself failing must not hide the other attempts.
      }
    }
  }
  if (summary.errors > 0) throw new Error(`reconcilePayments: ${summary.errors} of ${summary.checked} attempts failed`);
  return summary;
}
