import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyPayPal, expectedPayment, requestId, verifyAuthorization, type ExceptionReason, type PaymentResult } from "@/domain/payments";
import type { VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { cents } from "@/lib/money";
import { verifyApprovalBinding } from "@/services/quote/verify-binding";
import { reserveForPurchase } from "@/services/reservation/reserve";
import { auditStep, callPay, failureCodeOf, recordEvent, refusalCode, type PaymentDeps, type ServiceContext } from "./shared";
import { beginPayment, settlePayment } from "./settle";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Checked up front so a bad return address stops the checkout before anything is held. */
function checkReturnUrl(value: string): string {
  const url = new URL(value);
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new TypeError("return URL must be https");
  return url.toString();
}

const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const customerActor = (who: string) => `customer:${who}`;

export type Checkout = { attemptId: string; state: string; approveUrl: string | null };

type AttemptRow = {
  id: string;
  purchase_id: string;
  state: string;
  amount_minor: number;
  currency: "USD";
  paypal_order_id: string | null;
  authorization_id: string | null;
  approve_url: string | null;
  exception_reason: string | null;
  quote_hash: string;
};
const ATTEMPT_COLUMNS = "id, purchase_id, state, amount_minor, currency, paypal_order_id, authorization_id, approve_url, exception_reason, quote_hash";

async function loadAttempt(db: SupabaseClient, attemptId: string): Promise<AttemptRow> {
  const found = await db.from("payment_attempts").select(ATTEMPT_COLUMNS).eq("id", attemptId).single();
  if (found.error) throw new Error(`load attempt: ${found.error.message}`);
  return found.data as AttemptRow;
}

/**
 * Demo step A. Holds the stock and creates a PayPal order (intent AUTHORIZE) for exactly the accepted quote's total.
 * Safe to call again: an unfinished checkout is resumed, never duplicated. The amount comes only from the accepted
 * snapshot; the return address is the only thing the caller supplies.
 */
export async function startCheckout(
  db: SupabaseClient,
  deps: PaymentDeps,
  who: VerifiedInquiryId,
  purchaseId: string,
  options: { returnUrl: string },
  ctx: ServiceContext,
): Promise<PaymentResult<Checkout>> {
  const returnUrl = checkReturnUrl(options.returnUrl);

  const purchase = await db.from("purchases").select("id, inquiry_id, approval_id").eq("id", purchaseId).maybeSingle();
  if (purchase.error) throw new Error(`load purchase: ${purchase.error.message}`);
  if (!purchase.data || purchase.data.inquiry_id !== who) return { ok: false, code: "PURCHASE_NOT_FOUND" };

  const binding = await verifyApprovalBinding(db, purchase.data.approval_id as string);
  if (!binding.ok) return { ok: false, code: "QUOTE_NOT_ACCEPTED", cause: binding.code };
  const expected = expectedPayment(binding.value.snapshot);

  // An attempt past the point of resuming is reported before anything else is touched.
  const active = await db
    .from("payment_attempts")
    .select("id, state")
    .eq("purchase_id", purchaseId)
    .not("state", "in", "(CAPTURED,VOIDED,EXPIRED,FAILED)")
    .maybeSingle();
  if (active.error) throw new Error(`load attempt: ${active.error.message}`);
  if (active.data && !["CREATED", "PROVIDER_CREATED", "APPROVED"].includes(active.data.state as string)) {
    return { ok: false, code: "ATTEMPT_ACTIVE", cause: active.data.state as string };
  }

  const reserved = await reserveForPurchase(db, purchaseId, ctx);
  if (!reserved.ok) return { ok: false, code: "RESERVATION_REFUSED", cause: reserved.code };

  const created = await callPay(db, "payment_create_attempt", {
    p_purchase_id: purchaseId,
    p_amount_minor: expected.amountMinor,
    p_quote_hash: binding.value.quoteHash,
    p_now: ctx.now,
  });
  if (!created.ok) return { ok: false, code: refusalCode(created, "INVALID_INPUT"), ...(created.state ? { cause: created.state } : {}) };
  const attemptId = created.attempt_id!;
  if (!created.already) {
    await auditStep(db, ctx, customerActor(who), "payment.attempt_created", attemptId, {
      purchase_id: purchaseId,
      amount_minor: expected.amountMinor,
      currency: expected.currency,
      quote_hash: binding.value.quoteHash,
      to: "CREATED",
    });
  }

  if (created.state === "PROVIDER_CREATED") {
    const row = await loadAttempt(db, attemptId);
    return { ok: true, value: { attemptId, state: "PROVIDER_CREATED", approveUrl: row.approve_url } };
  }
  if (created.state === "APPROVED") return { ok: true, value: { attemptId, state: "APPROVED", approveUrl: null } };

  // CREATED: ask PayPal for the order. The request id is stable, so repeating after a lost answer gives the same order.
  const rid = requestId(attemptId, "create");
  const result = await deps.paypal.createOrder({
    amount: cents(expected.amountMinor),
    referenceId: attemptId,
    requestId: rid,
    returnUrl,
  });
  const verdict = classifyPayPal(result, "create");

  if (verdict === "DONE" && result.kind === "ok") {
    const link = result.data.approveUrl;
    if (!link || !/^https:\/\/([a-z0-9-]+\.)*paypal\.com\//i.test(link)) {
      await callPay(db, "payment_fail", { p_attempt_id: attemptId, p_failure_code: "NO_APPROVAL_LINK", p_now: ctx.now });
      return { ok: false, code: "PROVIDER_REFUSED", cause: "NO_APPROVAL_LINK" };
    }
    const recorded = await callPay(db, "payment_record_order", { p_attempt_id: attemptId, p_order_id: result.data.id, p_approve_url: link, p_now: ctx.now });
    if (!recorded.ok) return { ok: false, code: refusalCode(recorded, "ILLEGAL_TRANSITION") };
    await recordEvent(db, deps, attemptId, "payment.order_created", "api", {
      order_id: result.data.id,
      status: result.data.status,
      amount_minor: expected.amountMinor,
      currency: expected.currency,
      request_id: rid,
    });
    await auditStep(db, ctx, customerActor(who), "payment.order_created", attemptId, { from: "CREATED", to: "PROVIDER_CREATED" });
    return { ok: true, value: { attemptId, state: "PROVIDER_CREATED", approveUrl: link } };
  }

  if (verdict === "DEFINITIVE_FAILURE" && result.kind === "provider_error") {
    const code = failureCodeOf(result);
    await callPay(db, "payment_fail", { p_attempt_id: attemptId, p_failure_code: code, p_now: ctx.now });
    await auditStep(db, ctx, customerActor(who), "payment.failed", attemptId, { from: "CREATED", to: "FAILED", reason: code, status: result.status });
    return { ok: false, code: "PROVIDER_REFUSED", cause: code };
  }

  // Not sent, rate limited, or an answer that never arrived: creating an order moves no money, and repeating with the same request id is safe.
  return { ok: false, code: "PROVIDER_UNREACHABLE" };
}

export type Approval = { attemptId: string; state: string; already: boolean };

/**
 * Demo step B. The customer came back from PayPal. The return address is only an order id: PayPal is asked whether the
 * order is really approved, and only then is the authorization requested. Repeating, or racing, never sends a second
 * authorize: the begin step is atomic with the reservation, and an authorize whose outcome is unknown is never retried.
 */
export async function completeApproval(
  db: SupabaseClient,
  deps: PaymentDeps,
  who: VerifiedInquiryId,
  orderId: string,
  ctx: ServiceContext,
): Promise<PaymentResult<Approval>> {
  if (!ORDER_ID.test(orderId)) return { ok: false, code: "INVALID_INPUT" };

  const found = await db
    .from("payment_attempts")
    .select(`${ATTEMPT_COLUMNS}, purchases!inner(inquiry_id)`)
    .eq("paypal_order_id", orderId)
    .maybeSingle();
  if (found.error) throw new Error(`load attempt: ${found.error.message}`);
  if (!found.data) return { ok: false, code: "NOT_FOUND" };
  const raw = found.data as unknown as AttemptRow & { purchases: { inquiry_id: string } | { inquiry_id: string }[] };
  const owner = Array.isArray(raw.purchases) ? raw.purchases[0]!.inquiry_id : raw.purchases.inquiry_id;
  if (owner !== who) return { ok: false, code: "NOT_FOUND" };

  let attempt: AttemptRow = raw;
  const actor = customerActor(who);

  switch (attempt.state) {
    case "AUTHORIZED":
    case "CAPTURE_IN_FLIGHT":
    case "CAPTURED":
    case "VOID_IN_FLIGHT":
    case "VOIDED":
      return { ok: true, value: { attemptId: attempt.id, state: attempt.state, already: true } };
    case "OUTCOME_UNKNOWN":
      return { ok: false, code: "OUTCOME_UNKNOWN" };
    case "EXCEPTION":
      return { ok: false, code: "FINANCIAL_EXCEPTION", reasons: [attempt.exception_reason as ExceptionReason] };
    case "AUTHORIZE_IN_FLIGHT":
      return { ok: false, code: "ATTEMPT_ACTIVE", cause: "IN_FLIGHT" };
    case "FAILED":
    case "EXPIRED":
    case "CREATED":
      return { ok: false, code: "ILLEGAL_TRANSITION", cause: attempt.state };
    default:
      break;
  }

  if (attempt.state === "PROVIDER_CREATED") {
    const order = await deps.paypal.getOrder(orderId);
    if (order.kind !== "ok") return { ok: false, code: "PROVIDER_UNREACHABLE" };
    if (order.data.status === "VOIDED" || order.data.status === "EXPIRED") {
      const code = `ORDER_${order.data.status}`;
      await callPay(db, "payment_fail", { p_attempt_id: attempt.id, p_failure_code: code, p_now: ctx.now });
      await auditStep(db, ctx, actor, "payment.failed", attempt.id, { from: "PROVIDER_CREATED", to: "FAILED", reason: code });
      return { ok: false, code: "PROVIDER_REFUSED", cause: code };
    }
    if (order.data.status !== "APPROVED") return { ok: false, code: "NOT_APPROVED" };
    const marked = await callPay(db, "payment_mark_approved", { p_attempt_id: attempt.id, p_now: ctx.now });
    if (!marked.ok) return { ok: false, code: refusalCode(marked, "ILLEGAL_TRANSITION") };
    if (!marked.already) {
      await recordEvent(db, deps, attempt.id, "payment.order_approved", "api", { order_id: orderId, status: order.data.status });
      await auditStep(db, ctx, actor, "payment.order_approved", attempt.id, { from: "PROVIDER_CREATED", to: "APPROVED" });
    }
    attempt = await loadAttempt(db, attempt.id);
  }

  // From here the money may move. Begin first, atomically with the reservation; send only if it succeeded.
  const begun = await beginPayment(db, attempt.id, "authorize", ctx.now);
  if (!begun.ok) {
    if (begun.code === "RESERVATION_REFUSED") {
      const reason = begun.reservation_code ?? "UNKNOWN";
      if (reason === "OPERATION_IN_FLIGHT") return { ok: false, code: "ATTEMPT_ACTIVE", cause: "IN_FLIGHT" };
      return { ok: false, code: "RESERVATION_REFUSED", cause: reason };
    }
    // Someone else got there first: report what the attempt is now.
    const now = await loadAttempt(db, attempt.id);
    if (now.state === "AUTHORIZED") return { ok: true, value: { attemptId: attempt.id, state: "AUTHORIZED", already: true } };
    if (now.state === "OUTCOME_UNKNOWN") return { ok: false, code: "OUTCOME_UNKNOWN" };
    if (begun.code === "OPERATION_IN_FLIGHT" || now.state === "AUTHORIZE_IN_FLIGHT") return { ok: false, code: "ATTEMPT_ACTIVE", cause: "IN_FLIGHT" };
    return { ok: false, code: begun.code === "DECISION_ALREADY_MADE" ? "DECISION_ALREADY_MADE" : "ILLEGAL_TRANSITION", cause: now.state };
  }
  await auditStep(db, ctx, actor, "payment.authorize_begun", attempt.id, { from: "APPROVED", to: "AUTHORIZE_IN_FLIGHT", operation: "authorize" });

  const rid = requestId(attempt.id, "authorize");
  const result = await deps.paypal.authorizeOrder(orderId, rid);
  const verdict = classifyPayPal(result, "authorize");

  if (verdict === "DONE" && result.kind === "ok") {
    const a = result.data;
    const verification = verifyAuthorization(
      { amountMinor: attempt.amount_minor, currency: attempt.currency, paypalOrderId: attempt.paypal_order_id, authorizationId: null },
      { orderId: a.orderId, authorizationId: a.authorizationId, authorizationStatus: a.authorizationStatus, amountMinor: a.amountMinor, currency: a.currency },
    );
    const summary = { order_id: orderId, authorization_id: a.authorizationId, amount_minor: a.amountMinor, currency: a.currency, status: a.authorizationStatus, request_id: rid };
    if (!verification.ok) {
      await settlePayment(db, attempt.id, "EXCEPTION", ctx.now, { authorizationId: a.authorizationId, exceptionReason: verification.exception });
      await recordEvent(db, deps, attempt.id, "payment.authorize_exception", "api", { ...summary, outcome: verification.exception });
      await auditStep(db, ctx, actor, "payment.exception", attempt.id, { from: "AUTHORIZE_IN_FLIGHT", to: "EXCEPTION", reason: verification.exception });
      return { ok: false, code: "FINANCIAL_EXCEPTION", reasons: verification.reasons };
    }
    const settled = await settlePayment(db, attempt.id, "AUTHORIZED", ctx.now, {
      authorizationId: a.authorizationId,
      ...(a.expirationTime ? { authorizationExpiresAt: a.expirationTime } : {}),
    });
    if (!settled.ok) throw new Error(`payment_settle refused a verified authorization: ${settled.code}`);
    await recordEvent(db, deps, attempt.id, "payment.authorized", "api", summary);
    await auditStep(db, ctx, actor, "payment.authorized", attempt.id, { from: "AUTHORIZE_IN_FLIGHT", to: "AUTHORIZED", amount_minor: a.amountMinor, currency: a.currency });
    return { ok: true, value: { attemptId: attempt.id, state: "AUTHORIZED", already: false } };
  }

  if (verdict === "DEFINITIVE_FAILURE" && result.kind === "provider_error") {
    // PayPal saying the order was already authorized means an earlier answer was lost: that is doubt, not a refusal.
    if (result.issues.includes("ORDER_ALREADY_AUTHORIZED")) return markUnknown(db, deps, attempt.id, actor, ctx, "ORDER_ALREADY_AUTHORIZED");
    const code = failureCodeOf(result);
    await settlePayment(db, attempt.id, "AUTHORIZE_FAILED", ctx.now, { failureCode: code });
    await recordEvent(db, deps, attempt.id, "payment.authorize_failed", "api", { order_id: orderId, status: String(result.status), request_id: rid, outcome: code });
    await auditStep(db, ctx, actor, "payment.failed", attempt.id, { from: "AUTHORIZE_IN_FLIGHT", to: "FAILED", reason: code, status: result.status });
    return { ok: false, code: "PROVIDER_REFUSED", cause: code };
  }

  if (verdict === "NOT_SENT") {
    await settlePayment(db, attempt.id, "AUTHORIZE_NOT_DONE", ctx.now);
    await auditStep(db, ctx, actor, "payment.authorize_not_sent", attempt.id, { from: "AUTHORIZE_IN_FLIGHT", to: "APPROVED" });
    return { ok: false, code: "PROVIDER_UNREACHABLE" };
  }

  return markUnknown(db, deps, attempt.id, actor, ctx, result.kind);
}

/** The authorize may or may not have happened. Stock stays held, the reservation goes to review, nothing is retried here. */
async function markUnknown(
  db: SupabaseClient,
  deps: PaymentDeps,
  attemptId: string,
  actor: string,
  ctx: ServiceContext,
  why: string,
): Promise<PaymentResult<Approval>> {
  await settlePayment(db, attemptId, "UNKNOWN", ctx.now, { note: `authorize outcome unknown: ${why}` });
  await recordEvent(db, deps, attemptId, "payment.authorize_unknown", "api", { outcome: why.slice(0, 64) });
  await auditStep(db, ctx, actor, "payment.outcome_unknown", attemptId, { from: "AUTHORIZE_IN_FLIGHT", to: "OUTCOME_UNKNOWN", operation: "authorize", reason: why });
  return { ok: false, code: "OUTCOME_UNKNOWN" };
}
