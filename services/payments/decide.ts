import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyPayPal, requestId, verifyCapture, type PaymentResult } from "@/domain/payments";
import { cents } from "@/lib/money";
import type { MerchantActor } from "@/services/quote/shared";
import { verifyApprovalBinding } from "@/services/quote/verify-binding";
import { auditStep, callPay, failureCodeOf, recordEvent, refusalCode, type PaymentDeps, type ServiceContext } from "./shared";
import { beginPayment, settlePayment } from "./settle";

export type Decision = { decision: "accepted" | "declined"; state: string };

type AttemptRow = {
  id: string;
  state: string;
  amount_minor: number;
  currency: "USD";
  quote_hash: string;
  paypal_order_id: string | null;
  authorization_id: string | null;
};
const COLUMNS = "id, state, amount_minor, currency, quote_hash, paypal_order_id, authorization_id";

const merchantName = (actor: MerchantActor) => `merchant:${actor.userId}`;

async function attemptOfPurchase(
  db: SupabaseClient,
  purchaseId: string,
  merchantId: string,
): Promise<{ purchaseExists: boolean; approvalId: string | null; attempt: AttemptRow | null }> {
  const purchase = await db.from("purchases").select("id, approval_id").eq("id", purchaseId).eq("merchant_id", merchantId).maybeSingle();
  if (purchase.error) throw new Error(`load purchase: ${purchase.error.message}`);
  if (!purchase.data) return { purchaseExists: false, approvalId: null, attempt: null };
  const found = await db
    .from("payment_attempts")
    .select(COLUMNS)
    .eq("purchase_id", purchaseId)
    .not("state", "in", "(EXPIRED,FAILED)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (found.error) throw new Error(`load attempt: ${found.error.message}`);
  return { purchaseExists: true, approvalId: purchase.data.approval_id as string, attempt: (found.data as AttemptRow | null) ?? null };
}

/**
 * The merchant's one decision on an authorized order (demo steps C, D, E). Accept captures, decline voids. The decision
 * and the begin of the capture or void are one transaction; the money is only asked for after that, with a stable
 * request id, and the order is marked paid only when PayPal's own records confirm it. A repeated or racing decision
 * gets DECISION_ALREADY_MADE and sends nothing.
 */
export async function decide(
  db: SupabaseClient,
  deps: PaymentDeps,
  actor: MerchantActor,
  purchaseId: string,
  decision: "accepted" | "declined",
  input: { confirmedConditions?: string[]; reason?: string },
  ctx: ServiceContext,
  release: "DECLINED" | "VOIDED" = "DECLINED",
): Promise<PaymentResult<Decision>> {
  const found = await attemptOfPurchase(db, purchaseId, actor.merchantId);
  if (!found.purchaseExists) return { ok: false, code: "NOT_FOUND" };
  const attempt = found.attempt;
  if (decision === "accepted" && attempt && attempt.state === "AUTHORIZED") {
    // Before any decision is recorded: the quote must be intact and match the money that was authorized.
    const binding = await verifyApprovalBinding(db, found.approvalId!);
    if (!binding.ok) return { ok: false, code: "CAPTURE_BLOCKED", cause: binding.code };
    if (binding.value.quoteHash !== attempt.quote_hash || binding.value.snapshot.totalMinor !== attempt.amount_minor) {
      return { ok: false, code: "CAPTURE_BLOCKED", cause: "the quote no longer matches the authorized payment" };
    }
  }

  const out = await callPay(db, "payment_decide", {
    p_purchase_id: purchaseId,
    p_merchant_id: actor.merchantId,
    p_decision: decision,
    p_confirmed_conditions: input.confirmedConditions ?? [],
    p_reason: input.reason ?? null,
    p_now: ctx.now,
  });
  if (!out.ok) {
    const cause =
      typeof out.cause === "string"
        ? out.cause
        : Array.isArray(out.missing)
          ? (out.missing as string[]).join(",")
          : typeof out.decision === "string"
            ? out.decision
            : out.reservation_code;
    return { ok: false, code: refusalCode(out, "ILLEGAL_TRANSITION"), ...(cause ? { cause } : {}) };
  }

  const attemptId = out.attempt_id as string;
  const authorizationId = out.authorization_id as string;
  const actorName = merchantName(actor);
  await auditStep(db, ctx, actorName, `payment.decision_${decision}`, attemptId, {
    decision,
    from: "AUTHORIZED",
    to: decision === "accepted" ? "CAPTURE_IN_FLIGHT" : "VOID_IN_FLIGHT",
    operation: decision === "accepted" ? "capture" : "void",
    ...(decision === "declined" ? { reason: (input.reason ?? "").slice(0, 200) } : {}),
  });

  return decision === "accepted"
    ? sendCapture(db, deps, attemptId, authorizationId, actorName, ctx)
    : sendVoid(db, deps, attemptId, authorizationId, actorName, ctx, release);
}

async function sendCapture(
  db: SupabaseClient,
  deps: PaymentDeps,
  attemptId: string,
  authorizationId: string,
  actor: string,
  ctx: ServiceContext,
): Promise<PaymentResult<Decision>> {
  const { data, error } = await db.from("payment_attempts").select(COLUMNS).eq("id", attemptId).single();
  if (error) throw new Error(`load attempt: ${error.message}`);
  const attempt = data as AttemptRow;
  const rid = requestId(attemptId, "capture");
  const result = await deps.paypal.captureAuthorization(authorizationId, rid, { amount: cents(attempt.amount_minor), finalCapture: true });
  const verdict = classifyPayPal(result, "capture");

  if (verdict === "DONE" && result.kind === "ok") {
    const capture = result.data;
    // Linkage comes from PayPal's own record of the order, not from the capture answer.
    const order = await deps.paypal.getOrder(attempt.paypal_order_id!);
    if (order.kind !== "ok") return unknown(db, deps, attemptId, actor, ctx, "capture", "order could not be read to verify the capture");
    const verification = verifyCapture(
      { amountMinor: attempt.amount_minor, currency: attempt.currency, paypalOrderId: attempt.paypal_order_id, authorizationId: attempt.authorization_id },
      { id: order.data.id, authorizationId: order.data.authorizationId, captureId: order.data.captureId },
      { captureId: capture.captureId, status: capture.status, amountMinor: capture.amountMinor, currency: capture.currency },
      deps.payeeMerchantId === undefined ? undefined : { expected: deps.payeeMerchantId, actual: order.data.payeeMerchantId ?? null },
    );
    const summary = {
      order_id: attempt.paypal_order_id!,
      authorization_id: authorizationId,
      amount_minor: capture.amountMinor ?? 0,
      currency: capture.currency ?? "",
      status: capture.status,
      request_id: rid,
    };
    if (!verification.ok) {
      await settlePayment(db, attemptId, "EXCEPTION", ctx.now, { captureId: capture.captureId, exceptionReason: verification.exception });
      await recordEvent(db, deps, attemptId, "payment.capture_exception", "api", { ...summary, outcome: verification.exception });
      await auditStep(db, ctx, actor, "payment.exception", attemptId, { from: "CAPTURE_IN_FLIGHT", to: "EXCEPTION", reason: verification.exception });
      return { ok: false, code: "FINANCIAL_EXCEPTION", reasons: verification.reasons };
    }
    const settled = await settlePayment(db, attemptId, "CAPTURED", ctx.now, { captureId: capture.captureId });
    if (!settled.ok) throw new Error(`payment_settle refused a verified capture: ${settled.code}`);
    await recordEvent(db, deps, attemptId, "payment.captured", "api", summary);
    await auditStep(db, ctx, actor, "payment.captured", attemptId, { from: "CAPTURE_IN_FLIGHT", to: "CAPTURED", amount_minor: attempt.amount_minor, currency: attempt.currency });
    return { ok: true, value: { decision: "accepted", state: "CAPTURED" } };
  }

  if (verdict === "DEFINITIVE_FAILURE" && result.kind === "provider_error") {
    // An authorization PayPal says is already captured or voided means an answer was lost or someone acted elsewhere: doubt.
    if (result.issues.some((i) => i === "AUTHORIZATION_ALREADY_CAPTURED" || i === "PREVIOUSLY_CAPTURED" || i === "AUTHORIZATION_VOIDED")) {
      return unknown(db, deps, attemptId, actor, ctx, "capture", result.issues[0]!);
    }
    const code = failureCodeOf(result);
    await settlePayment(db, attemptId, "CAPTURE_FAILED", ctx.now);
    await recordEvent(db, deps, attemptId, "payment.capture_failed", "api", { status: String(result.status), request_id: rid, outcome: code });
    await auditStep(db, ctx, actor, "payment.capture_failed", attemptId, { from: "CAPTURE_IN_FLIGHT", to: "AUTHORIZED", reason: code, status: result.status });
    return { ok: false, code: "PROVIDER_REFUSED", cause: code };
  }

  if (verdict === "NOT_SENT") {
    await settlePayment(db, attemptId, "CAPTURE_FAILED", ctx.now);
    await auditStep(db, ctx, actor, "payment.capture_not_sent", attemptId, { from: "CAPTURE_IN_FLIGHT", to: "AUTHORIZED" });
    return { ok: false, code: "PROVIDER_UNREACHABLE" };
  }
  return unknown(db, deps, attemptId, actor, ctx, "capture", result.kind);
}

async function sendVoid(
  db: SupabaseClient,
  deps: PaymentDeps,
  attemptId: string,
  authorizationId: string,
  actor: string,
  ctx: ServiceContext,
  release: "DECLINED" | "VOIDED",
): Promise<PaymentResult<Decision>> {
  const rid = requestId(attemptId, "void");
  const result = await deps.paypal.voidAuthorization(authorizationId, rid);
  const verdict = classifyPayPal(result, "void");

  if (verdict === "DONE") {
    const settled = await settlePayment(db, attemptId, "VOIDED", ctx.now, { releaseReason: release });
    if (!settled.ok) throw new Error(`payment_settle refused a void: ${settled.code}`);
    await recordEvent(db, deps, attemptId, "payment.voided", "api", { authorization_id: authorizationId, status: "VOIDED", request_id: rid });
    await auditStep(db, ctx, actor, "payment.voided", attemptId, { from: "VOID_IN_FLIGHT", to: "VOIDED" });
    return { ok: true, value: { decision: "declined", state: "VOIDED" } };
  }

  if (verdict === "DEFINITIVE_FAILURE" && result.kind === "provider_error") {
    if (result.issues.includes("PREVIOUSLY_CAPTURED")) {
      // Observed on the real sandbox: the money was already captured. Never mark it voided; a person decides.
      await settlePayment(db, attemptId, "EXCEPTION", ctx.now, { exceptionReason: "STATUS_NOT_AS_EXPECTED" });
      await recordEvent(db, deps, attemptId, "payment.void_exception", "api", {
        authorization_id: authorizationId,
        status: String(result.status),
        request_id: rid,
        outcome: "PREVIOUSLY_CAPTURED",
      });
      await auditStep(db, ctx, actor, "payment.exception", attemptId, { from: "VOID_IN_FLIGHT", to: "EXCEPTION", reason: "STATUS_NOT_AS_EXPECTED" });
      return { ok: false, code: "FINANCIAL_EXCEPTION", reasons: ["STATUS_NOT_AS_EXPECTED"] };
    }
    if (result.issues.includes("AUTHORIZATION_VOIDED")) return unknown(db, deps, attemptId, actor, ctx, "void", "AUTHORIZATION_VOIDED");
    const code = failureCodeOf(result);
    await settlePayment(db, attemptId, "VOID_FAILED", ctx.now);
    await auditStep(db, ctx, actor, "payment.void_failed", attemptId, { from: "VOID_IN_FLIGHT", to: "AUTHORIZED", reason: code, status: result.status });
    return { ok: false, code: "PROVIDER_REFUSED", cause: code };
  }

  if (verdict === "NOT_SENT") {
    await settlePayment(db, attemptId, "VOID_FAILED", ctx.now);
    await auditStep(db, ctx, actor, "payment.void_not_sent", attemptId, { from: "VOID_IN_FLIGHT", to: "AUTHORIZED" });
    return { ok: false, code: "PROVIDER_UNREACHABLE" };
  }
  return unknown(db, deps, attemptId, actor, ctx, "void", result.kind);
}

async function unknown(
  db: SupabaseClient,
  deps: PaymentDeps,
  attemptId: string,
  actor: string,
  ctx: ServiceContext,
  operation: "capture" | "void",
  why: string,
): Promise<PaymentResult<Decision>> {
  await settlePayment(db, attemptId, "UNKNOWN", ctx.now, { note: `${operation} outcome unknown: ${why}` });
  await recordEvent(db, deps, attemptId, `payment.${operation}_unknown`, "api", { outcome: why.slice(0, 64) });
  await auditStep(db, ctx, actor, "payment.outcome_unknown", attemptId, {
    from: operation === "capture" ? "CAPTURE_IN_FLIGHT" : "VOID_IN_FLIGHT",
    to: "OUTCOME_UNKNOWN",
    operation,
    reason: why,
  });
  return { ok: false, code: "OUTCOME_UNKNOWN" };
}

/**
 * A change after authorization (demo step H): the merchant cancels the order, which voids the authorization and
 * releases the stock. A new quote, approval and attempt are needed afterwards; the old authorization is never moved.
 * Once the money has been captured this refuses with ALREADY_CAPTURED: only a person can refund it.
 */
export async function voidForChange(
  db: SupabaseClient,
  deps: PaymentDeps,
  actor: MerchantActor,
  purchaseId: string,
  reason: string,
  ctx: ServiceContext,
): Promise<PaymentResult<{ state: string }>> {
  const found = await attemptOfPurchase(db, purchaseId, actor.merchantId);
  if (!found.purchaseExists) return { ok: false, code: "NOT_FOUND" };
  if (found.attempt && ["CAPTURED", "CAPTURE_IN_FLIGHT"].includes(found.attempt.state)) {
    return { ok: false, code: "ALREADY_CAPTURED", cause: "the money is already captured; a refund must be resolved by the merchant in PayPal" };
  }
  const result = await decide(db, deps, actor, purchaseId, "declined", { reason }, ctx, "VOIDED");
  return result.ok ? { ok: true, value: { state: result.value.state } } : result;
}

/**
 * Completes a recorded decision whose operation did not happen: reconciliation found the capture (or void) was never
 * done, so the attempt is AUTHORIZED again with an accepted (or declined) decision. Begins the operation again and sends
 * it with the same stable request id, so PayPal can never perform it twice.
 */
export async function resumeDecision(db: SupabaseClient, deps: PaymentDeps, attemptId: string, ctx: ServiceContext): Promise<PaymentResult<Decision>> {
  const found = await db.from("payment_attempts").select("id, state, purchase_id, authorization_id").eq("id", attemptId).maybeSingle();
  if (found.error) throw new Error(`load attempt: ${found.error.message}`);
  if (!found.data) return { ok: false, code: "NOT_FOUND" };
  if (found.data.state !== "AUTHORIZED") return { ok: false, code: "ILLEGAL_TRANSITION", cause: found.data.state as string };
  const dec = await db.from("merchant_decisions").select("decision, authorization_id").eq("purchase_id", found.data.purchase_id).maybeSingle();
  if (dec.error) throw new Error(`load decision: ${dec.error.message}`);
  if (!dec.data || dec.data.decision === "pending") return { ok: false, code: "ILLEGAL_TRANSITION", cause: "no decision to carry out" };
  if (dec.data.authorization_id !== found.data.authorization_id) return { ok: false, code: "CAPTURE_BLOCKED", cause: "the decision is for another authorization" };

  const operation = dec.data.decision === "accepted" ? "capture" : "void";
  const begun = await beginPayment(db, attemptId, operation, ctx.now);
  if (!begun.ok) return { ok: false, code: refusalCode(begun, "ILLEGAL_TRANSITION"), ...(typeof begun.cause === "string" ? { cause: begun.cause } : {}) };
  const actor = ctx.actor ?? "system:cron";
  await auditStep(db, ctx, actor, "payment.operation_resumed", attemptId, { from: "AUTHORIZED", operation });
  const authorizationId = found.data.authorization_id as string;
  return operation === "capture"
    ? sendCapture(db, deps, attemptId, authorizationId, actor, ctx)
    : sendVoid(db, deps, attemptId, authorizationId, actor, ctx, "DECLINED");
}
