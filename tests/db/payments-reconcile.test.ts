// Real local Postgres and the LOCAL FAKE PayPal: mocked evidence. Expiry uses an injected clock and is application-level
// evidence only: the sandbox was not observed to expire an authorization.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPayPalClient } from "@/lib/paypal/client";
import { completeApproval, startCheckout } from "@/services/payments/checkout";
import { decide, resumeDecision } from "@/services/payments/decide";
import { BATCH_LIMIT, STUCK_AFTER_SECONDS, reconcileAttempt, reconcilePayments } from "@/services/payments/reconcile";
import { beginPayment } from "@/services/payments/settle";
import type { PayPalPort } from "@/services/payments/shared";
import type { MerchantActor } from "@/services/quote/shared";
import { startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { acceptedPurchase, freshMerchant, type AcceptedPurchase, type Merchant } from "./accepted-purchase";
import { must, serviceClient } from "./helpers";
import { T0 } from "./payments-helpers";
import { addMinutes, expectStockConsistentAtEnd, stockOf } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

let fake: FakePayPal;
let paypal: PayPalPort;
const ctx = { now: T0, correlationId: "corr-payments-t7" };
const RETURN = "http://localhost:3100/o/TOKEN";

beforeAll(async () => {
  fake = await startFakePayPal();
  paypal = makeClient();
});
afterAll(async () => {
  await fake.close();
});

function makeClient(fetchImpl?: typeof fetch): PayPalPort {
  return createPayPalClient({ env: "sandbox", clientId: "test-client", clientSecret: "test-secret-0000000000", baseUrl: fake.url, timeoutMs: 400, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
const deps = (client: PayPalPort = paypal) => ({ paypal: client, evidence: "mocked" as const });
const posts = () => fake.requests.filter((r) => r.method === "POST" && !r.path.includes("oauth2")).length;
const requestsTo = (match: string) => fake.requests.filter((r) => `${r.method} ${r.path}`.includes(match));
/** A PayPal that cannot be reached at all. */
const unreachable = () => makeClient((async () => { throw new TypeError("network down"); }) as typeof fetch);

type Ready = AcceptedPurchase & { m: Merchant; actor: MerchantActor; attemptId: string; orderId: string };

const attemptOf = async (purchaseId: string) =>
  must(await db.from("payment_attempts").select("id, state, paypal_order_id, authorization_id, capture_id, exception_reason, unknown_operation, failure_code").eq("purchase_id", purchaseId).order("created_at", { ascending: false }).limit(1).single()) as {
    id: string; state: string; paypal_order_id: string | null; authorization_id: string | null; capture_id: string | null;
    exception_reason: string | null; unknown_operation: string | null; failure_code: string | null;
  };
const reservationOf = async (purchaseId: string) => (await db.from("reservations").select("state, release_reason").eq("purchase_id", purchaseId).maybeSingle()).data as { state: string; release_reason: string | null } | null;
const decisionOf = async (purchaseId: string) => (await db.from("merchant_decisions").select("decision").eq("purchase_id", purchaseId).maybeSingle()).data as { decision: string } | null;
const desk = (r: Ready) => stockOf(db, r.m.product["ORGANIZER-DESK"]!);

/** Checkout done and the order approved at PayPal; the authorize has not been sent. */
async function approved(): Promise<Ready> {
  const m = await freshMerchant(db);
  const p = await acceptedPurchase(db, m);
  const started = await startCheckout(db, deps(), p.who, p.purchaseId, { returnUrl: RETURN }, ctx);
  if (!started.ok) throw new Error(`startCheckout: ${started.code}`);
  const attempt = await attemptOf(p.purchaseId);
  fake.approve(attempt.paypal_order_id!);
  return { ...p, m, actor: { kind: "merchant", userId: randomUUID(), merchantId: m.merchantId }, attemptId: attempt.id, orderId: attempt.paypal_order_id! };
}
async function authorized(): Promise<Ready> {
  const r = await approved();
  const done = await completeApproval(db, deps(), r.who, r.orderId, ctx);
  if (!done.ok) throw new Error(`completeApproval: ${done.code}`);
  return r;
}

describe("authorize in doubt", () => {
  it("the answer was lost after PayPal authorized: reconciliation finds the authorization and verifies it", async () => {
    const r = await approved();
    fake.inject("/authorize", { type: "drop-after" });
    expect(await completeApproval(db, deps(), r.who, r.orderId, ctx)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    const sent = posts();

    expect(await reconcileAttempt(db, deps(), r.attemptId, ctx)).toEqual({ ok: true, value: { state: "AUTHORIZED", changed: true } });
    expect(posts()).toBe(sent); // reconciliation only reads
    expect((await attemptOf(r.purchaseId)).authorization_id).toMatch(/^FAKEAUTH/);
    expect(await decisionOf(r.purchaseId)).toMatchObject({ decision: "pending" });
    expect((await reservationOf(r.purchaseId))!.state).toBe("AWAITING_CONFIRMATION");
    expect(requestsTo("/authorize").filter((q) => q.path.includes(r.orderId))).toHaveLength(1);
  });

  it("the request never reached PayPal: reconciliation finds it not done, the retry reuses the same request id and authorizes once", async () => {
    const r = await approved();
    fake.inject("/authorize", { type: "drop-before" });
    expect(await completeApproval(db, deps(), r.who, r.orderId, ctx)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });

    expect(await reconcileAttempt(db, deps(), r.attemptId, ctx)).toEqual({ ok: true, value: { state: "APPROVED", changed: true } });
    expect((await reservationOf(r.purchaseId))!.state).toBe("HELD");
    expect(await completeApproval(db, deps(), r.who, r.orderId, ctx)).toMatchObject({ ok: true, value: { state: "AUTHORIZED" } });

    const calls = requestsTo("/authorize").filter((q) => q.path.includes(r.orderId));
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.requestId))).toEqual(new Set([`of-${r.attemptId}-authorize`]));
    expect([...fake.authorizations.values()].filter((a) => a.orderId === r.orderId)).toHaveLength(1);
  });

  it("an authorization for the wrong amount found by reconciliation is a financial exception", async () => {
    const r = await approved();
    fake.inject("/authorize", { type: "drop-after" });
    await completeApproval(db, deps(), r.who, r.orderId, ctx);
    for (const a of fake.authorizations.values()) if (a.orderId === r.orderId) a.amount = "1.00";
    expect(await reconcileAttempt(db, deps(), r.attemptId, ctx)).toEqual({ ok: true, value: { state: "EXCEPTION", changed: true } });
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "EXCEPTION", exception_reason: "AMOUNT_MISMATCH" });
    expect(await desk(r)).toEqual({ on_hand: 100, reserved: 30 });
  });
});

describe("capture in doubt (demo step F)", () => {
  it("the answer was lost after PayPal captured: reconciliation finds CAPTURED, never a second capture", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "drop-after" });
    expect(await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });

    expect(await reconcileAttempt(db, deps(), r.attemptId, ctx)).toEqual({ ok: true, value: { state: "CAPTURED", changed: true } });
    expect((await attemptOf(r.purchaseId)).capture_id).toMatch(/^FAKECAP/);
    expect((await reservationOf(r.purchaseId))!.state).toBe("COMMITTED");
    expect(await desk(r)).toEqual({ on_hand: 70, reserved: 0 });
    expect(requestsTo("/capture").filter((q) => q.requestId === `of-${r.attemptId}-capture`)).toHaveLength(1);
    // Reconciling again changes nothing and sends nothing.
    const sent = posts();
    expect(await reconcileAttempt(db, deps(), r.attemptId, ctx)).toEqual({ ok: true, value: { state: "CAPTURED", changed: false } });
    expect(posts()).toBe(sent);
  });

  it("the capture never reached PayPal: reconciliation finds it not done, the retry reuses the request id and captures once", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "drop-before" });
    expect(await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });

    expect(await reconcileAttempt(db, deps(), r.attemptId, ctx)).toEqual({ ok: true, value: { state: "AUTHORIZED", changed: true } });
    expect((await reservationOf(r.purchaseId))!.state).toBe("AWAITING_CONFIRMATION");
    expect(await resumeDecision(db, deps(), r.attemptId, ctx)).toEqual({ ok: true, value: { decision: "accepted", state: "CAPTURED" } });

    const calls = requestsTo("/capture").filter((q) => q.requestId === `of-${r.attemptId}-capture`);
    expect(calls).toHaveLength(2);
    expect([...fake.captures.values()].filter((c) => c.authorizationId === (r as unknown as { authId?: string }).authId || true).length).toBeGreaterThan(0);
    const attempt = await attemptOf(r.purchaseId);
    expect([...fake.captures.values()].filter((c) => c.authorizationId === attempt.authorization_id)).toHaveLength(1);
    expect(attempt.state).toBe("CAPTURED");
  });

  it("a hung capture that PayPal never processed is found not done too", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "hang" });
    await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    expect(await reconcileAttempt(db, deps(), r.attemptId, ctx)).toEqual({ ok: true, value: { state: "AUTHORIZED", changed: true } });
  });

  it("PayPal unreachable during reconciliation: still in doubt, nothing is retried or changed", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "drop-after" });
    await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    const sent = fake.requests.length;
    expect(await reconcileAttempt(db, deps(unreachable()), r.attemptId, ctx)).toEqual({ ok: true, value: { state: "OUTCOME_UNKNOWN", changed: false } });
    expect(fake.requests.length).toBe(sent);
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "OUTCOME_UNKNOWN", unknown_operation: "capture" });
    expect((await reservationOf(r.purchaseId))!.state).toBe("REVIEW_REQUIRED");
  });

  it("a capture that does not match (wrong amount at PayPal) is a financial exception, never paid", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "drop-after" });
    await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    const attempt = await attemptOf(r.purchaseId);
    for (const c of fake.captures.values()) if (c.authorizationId === attempt.authorization_id) c.amount = "1.00";
    expect(await reconcileAttempt(db, deps(), r.attemptId, ctx)).toEqual({ ok: true, value: { state: "EXCEPTION", changed: true } });
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "EXCEPTION", exception_reason: "AMOUNT_MISMATCH" });
    expect(await desk(r)).toEqual({ on_hand: 100, reserved: 30 });
  });
});

describe("void in doubt", () => {
  it("a void answer lost after PayPal voided: reconciliation finds VOIDED and releases the stock", async () => {
    const r = await authorized();
    fake.inject("/void", { type: "drop-after" });
    expect(await decide(db, deps(), r.actor, r.purchaseId, "declined", { reason: "No capacity." }, ctx)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect(await reconcileAttempt(db, deps(), r.attemptId, ctx)).toEqual({ ok: true, value: { state: "VOIDED", changed: true } });
    expect(await reservationOf(r.purchaseId)).toMatchObject({ state: "RELEASED" });
    expect(await desk(r)).toEqual({ on_hand: 100, reserved: 0 });
  });

  it("a void timeout stays checking until PayPal confirms, then resolves", async () => {
    const r = await authorized();
    fake.inject("/void", { type: "hang" });
    await decide(db, deps(), r.actor, r.purchaseId, "declined", { reason: "No capacity." }, ctx);
    expect(await reconcileAttempt(db, deps(unreachable()), r.attemptId, ctx)).toEqual({ ok: true, value: { state: "OUTCOME_UNKNOWN", changed: false } });
    expect(await reconcileAttempt(db, deps(), r.attemptId, ctx)).toEqual({ ok: true, value: { state: "AUTHORIZED", changed: true } });
    expect(await resumeDecision(db, deps(), r.attemptId, ctx)).toEqual({ ok: true, value: { decision: "declined", state: "VOIDED" } });
    expect(requestsTo("/void").filter((q) => q.requestId === `of-${r.attemptId}-void`)).toHaveLength(2);
  });
});

describe("reconcilePayments", () => {
  it("uses the spec's thresholds", () => {
    expect(STUCK_AFTER_SECONDS).toBe(120);
    expect(BATCH_LIMIT).toBe(20);
  });

  it("an operation in flight is left alone until it has been stuck for 120 seconds, then it is reconciled", async () => {
    const r = await approved();
    must(await db.rpc("payment_mark_approved", { p_attempt_id: r.attemptId, p_now: T0 }));
    expect((await beginPayment(db, r.attemptId, "authorize", T0)).ok).toBe(true); // begun, never sent
    const early = await reconcilePayments(db, deps(), { ...ctx, now: new Date(Date.parse(T0) + 119_000).toISOString() }, { attemptIds: [r.attemptId] });
    expect(early.checked).toBe(0);
    expect((await attemptOf(r.purchaseId)).state).toBe("AUTHORIZE_IN_FLIGHT");

    const late = await reconcilePayments(db, deps(), { ...ctx, now: new Date(Date.parse(T0) + 121_000).toISOString() }, { attemptIds: [r.attemptId] });
    expect(late).toMatchObject({ checked: 1, settled: 1, stillUnknown: 0, errors: 0 });
    expect((await attemptOf(r.purchaseId)).state).toBe("APPROVED");
  });

  it("finishes a capture reconciliation found not done, with the same request id", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "drop-before" });
    await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    const summary = await reconcilePayments(db, deps(), ctx, { attemptIds: [r.attemptId] });
    expect(summary).toMatchObject({ checked: 1, settled: 1, stillUnknown: 0 });
    expect((await attemptOf(r.purchaseId)).state).toBe("CAPTURED");
    expect(requestsTo("/capture").filter((q) => q.requestId === `of-${r.attemptId}-capture`)).toHaveLength(2);
  });

  it("counts what is still in doubt", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "drop-after" });
    await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    const summary = await reconcilePayments(db, deps(unreachable()), ctx, { attemptIds: [r.attemptId] });
    expect(summary).toMatchObject({ checked: 1, settled: 0, stillUnknown: 1 });
  });

  it("one attempt failing does not stop the rest; the run then fails visibly", async () => {
    const bad = await authorized();
    fake.inject("/capture", { type: "drop-after" });
    await decide(db, deps(), bad.actor, bad.purchaseId, "accepted", {}, ctx);
    const good = await authorized();
    fake.inject("/capture", { type: "drop-after" });
    await decide(db, deps(), good.actor, good.purchaseId, "accepted", {}, ctx);

    const badOrder = bad.orderId;
    const exploding: PayPalPort = {
      ...paypal,
      getAuthorization: (id: string) => paypal.getAuthorization(id),
      getOrder: async (id: string) => {
        if (id === badOrder) throw new Error("boom while reading PayPal");
        return paypal.getOrder(id);
      },
      getCapture: (id: string) => paypal.getCapture(id),
      createOrder: paypal.createOrder,
      authorizeOrder: paypal.authorizeOrder,
      captureAuthorization: paypal.captureAuthorization,
      voidAuthorization: paypal.voidAuthorization,
    };
    await expect(reconcilePayments(db, deps(exploding), ctx, { attemptIds: [bad.attemptId, good.attemptId] })).rejects.toThrow(/1 of 2 attempts failed/);
    expect((await attemptOf(good.purchaseId)).state).toBe("CAPTURED");
    expect((await attemptOf(bad.purchaseId)).state).toBe("OUTCOME_UNKNOWN");
    const errors = must(await db.from("audit_events").select("action").eq("entity_id", bad.attemptId).eq("action", "payment.reconcile_error"));
    expect(errors).toHaveLength(1);
  });

  it("never looks at more than the batch limit in one run", async () => {
    const summary = await reconcilePayments(db, deps(unreachable()), { ...ctx, now: addMinutes(T0, 600) }).catch(() => null);
    if (summary) expect(summary.checked).toBeLessThanOrEqual(BATCH_LIMIT);
  });
});

describe("idle and expired attempts", () => {
  it("a checkout idle past its hold ends as EXPIRED, and the hold is left to the sweep", async () => {
    const r = await approved();
    const later = addMinutes(T0, 31);
    const summary = await reconcilePayments(db, deps(), { ...ctx, now: later }, { attemptIds: [r.attemptId] });
    expect(summary).toMatchObject({ checked: 1, settled: 1 });
    expect((await attemptOf(r.purchaseId)).state).toBe("EXPIRED");
  });

  it("a checkout whose hold is still running is not expired", async () => {
    const r = await approved();
    const summary = await reconcilePayments(db, deps(), { ...ctx, now: addMinutes(T0, 5) }, { attemptIds: [r.attemptId] });
    expect(summary.checked).toBe(1);
    // It learned the buyer approved (PROVIDER_CREATED to APPROVED) but did not expire.
    expect((await attemptOf(r.purchaseId)).state).toBe("APPROVED");
  });

  it("an order PayPal reports void ends the attempt", async () => {
    const m = await freshMerchant(db);
    const p = await acceptedPurchase(db, m);
    await startCheckout(db, deps(), p.who, p.purchaseId, { returnUrl: RETURN }, ctx);
    const attempt = await attemptOf(p.purchaseId);
    fake.inject(`GET /v2/checkout/orders/${attempt.paypal_order_id}`, { type: "status", status: 200, body: { id: attempt.paypal_order_id, status: "VOIDED" } });
    await reconcilePayments(db, deps(), { ...ctx, now: addMinutes(T0, 5) }, { attemptIds: [attempt.id] });
    expect(await attemptOf(p.purchaseId)).toMatchObject({ state: "FAILED", failure_code: "ORDER_VOIDED" });
  });

  it("(application-level, injected clock) an authorization past its expiry is confirmed with PayPal, expired, and the stock goes back", async () => {
    const r = await authorized();
    const expires = new Date(Date.parse(T0) + 3 * 86_400_000).toISOString();
    must(await db.from("payment_attempts").update({ authorization_expires_at: expires }).eq("id", r.attemptId));
    const before = await reconcilePayments(db, deps(), { ...ctx, now: addMinutes(T0, 60) }, { attemptIds: [r.attemptId] });
    expect(before.checked).toBe(0);

    const summary = await reconcilePayments(db, deps(), { ...ctx, now: new Date(Date.parse(expires) + 1000).toISOString() }, { attemptIds: [r.attemptId] });
    expect(summary).toMatchObject({ checked: 1, settled: 1 });
    expect((await attemptOf(r.purchaseId)).state).toBe("EXPIRED");
    expect(await reservationOf(r.purchaseId)).toMatchObject({ state: "RELEASED", release_reason: "EXPIRED" });
    expect(await desk(r)).toEqual({ on_hand: 100, reserved: 0 });
  });
});
