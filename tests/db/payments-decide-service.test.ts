// Real local Postgres and the LOCAL FAKE PayPal: every PayPal answer is mocked evidence (label: mocked).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPayPalClient } from "@/lib/paypal/client";
import { cents } from "@/lib/money";
import { completeApproval, startCheckout } from "@/services/payments/checkout";
import { decide, voidForChange } from "@/services/payments/decide";
import type { PayPalPort } from "@/services/payments/shared";
import type { MerchantActor } from "@/services/quote/shared";
import { FAKE_PAYEE, startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { acceptedPurchase, freshMerchant, type AcceptedPurchase, type Merchant } from "./accepted-purchase";
import { must, serviceClient } from "./helpers";
import { T0 } from "./payments-helpers";
import { expectStockConsistentAtEnd, stockOf } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

let fake: FakePayPal;
let paypal: PayPalPort;
const ctx = { now: T0, correlationId: "corr-payments-t6" };
const SLOT = { code: "PRODUCTION_SLOT_CONFIRMATION", text: "Production slot to be confirmed." };

beforeAll(async () => {
  fake = await startFakePayPal();
  paypal = createPayPalClient({ env: "sandbox", clientId: "test-client", clientSecret: "test-secret-0000000000", baseUrl: fake.url, timeoutMs: 400 });
});
afterAll(async () => {
  await fake.close();
});

const deps = (extra: { payeeMerchantId?: string } = {}) => ({ paypal, evidence: "mocked" as const, ...extra });
const requestsTo = (match: string) => fake.requests.filter((r) => `${r.method} ${r.path}`.includes(match));
const captureCalls = () => requestsTo("/capture").length;

type Ready = AcceptedPurchase & { m: Merchant; actor: MerchantActor };
/** An accepted quote whose payment is AUTHORIZED, waiting for the merchant (demo steps A and B done). */
async function authorized(opts: { conditions?: unknown[] } = {}): Promise<Ready> {
  const m = await freshMerchant(db);
  const p = await acceptedPurchase(db, m, opts);
  const started = await startCheckout(db, deps(), p.who, p.purchaseId, { returnUrl: "http://localhost:3100/o/TOKEN" }, ctx);
  if (!started.ok) throw new Error(`startCheckout: ${started.code}`);
  const orderId = (await attemptOf(p.purchaseId)).paypal_order_id!;
  fake.approve(orderId);
  const done = await completeApproval(db, deps(), p.who, orderId, ctx);
  if (!done.ok) throw new Error(`completeApproval: ${done.code}`);
  return { ...p, m, actor: { kind: "merchant", userId: randomUUID(), merchantId: m.merchantId } };
}

const attemptOf = async (purchaseId: string) =>
  must(await db.from("payment_attempts").select("id, state, paypal_order_id, authorization_id, capture_id, exception_reason, unknown_operation, failure_code").eq("purchase_id", purchaseId).order("created_at", { ascending: false }).limit(1).single()) as {
    id: string; state: string; paypal_order_id: string | null; authorization_id: string | null; capture_id: string | null;
    exception_reason: string | null; unknown_operation: string | null; failure_code: string | null;
  };
const reservationOf = async (purchaseId: string) => (await db.from("reservations").select("state, release_reason").eq("purchase_id", purchaseId).maybeSingle()).data as { state: string; release_reason: string | null } | null;
const decisionOf = async (purchaseId: string) => (await db.from("merchant_decisions").select("decision, reason, confirmed_conditions").eq("purchase_id", purchaseId).maybeSingle()).data as { decision: string; reason: string | null; confirmed_conditions: string[] } | null;
const eventsOf = async (attemptId: string) => must(await db.from("payment_events").select("event_type, evidence_label, payload").eq("payment_attempt_id", attemptId).order("created_at")) as Array<{ event_type: string; evidence_label: string; payload: Record<string, unknown> }>;
const auditOf = async (attemptId: string) => must(await db.from("audit_events").select("action, actor").eq("entity", "payment_attempt").eq("entity_id", attemptId).order("id")) as Array<{ action: string; actor: string }>;
const desk = (r: Ready) => stockOf(db, r.m.product["ORGANIZER-DESK"]!);

describe("decide: accept (demo step C)", () => {
  it("captures exactly the authorized total, marks it CAPTURED only after PayPal's records agree, and commits the stock", async () => {
    const r = await authorized();
    const result = await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    expect(result).toEqual({ ok: true, value: { decision: "accepted", state: "CAPTURED" } });

    const attempt = await attemptOf(r.purchaseId);
    expect(attempt.state).toBe("CAPTURED");
    expect(attempt.capture_id).toMatch(/^FAKECAP/);
    expect(await decisionOf(r.purchaseId)).toMatchObject({ decision: "accepted" });
    expect(await reservationOf(r.purchaseId)).toMatchObject({ state: "COMMITTED" });
    expect(await desk(r)).toEqual({ on_hand: 70, reserved: 0 });

    const call = requestsTo("/capture")[0]!;
    expect(call.requestId).toBe(`of-${attempt.id}-capture`);
    expect(call.body).toMatchObject({ amount: { currency_code: "USD", value: "1080.00" }, final_capture: true });

    expect((await eventsOf(attempt.id)).at(-1)).toMatchObject({ event_type: "payment.captured", evidence_label: "mocked" });
    const audit = await auditOf(attempt.id);
    expect(audit.map((a) => a.action).slice(-2)).toEqual(["payment.decision_accepted", "payment.captured"]);
    expect(audit.at(-1)!.actor).toBe(`merchant:${r.actor.userId}`);
  });

  it("every pending condition must be confirmed first: nothing is decided or sent otherwise", async () => {
    const r = await authorized({ conditions: [SLOT] });
    const before = captureCalls();
    expect(await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx)).toMatchObject({ ok: false, code: "CONDITIONS_UNCONFIRMED", cause: "PRODUCTION_SLOT_CONFIRMATION" });
    expect(await decisionOf(r.purchaseId)).toMatchObject({ decision: "pending" });
    expect(captureCalls()).toBe(before);
    expect((await attemptOf(r.purchaseId)).state).toBe("AUTHORIZED");

    expect((await decide(db, deps(), r.actor, r.purchaseId, "accepted", { confirmedConditions: ["PRODUCTION_SLOT_CONFIRMATION"] }, ctx)).ok).toBe(true);
    expect(await decisionOf(r.purchaseId)).toMatchObject({ decision: "accepted", confirmed_conditions: ["PRODUCTION_SLOT_CONFIRMATION"] });
  });

  it("demo step E: a repeated accept captures once", async () => {
    const r = await authorized();
    await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    expect(await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx)).toMatchObject({ ok: false, code: "DECISION_ALREADY_MADE" });
    expect(captureCalls()).toBe(requestsTo("/capture").length);
    expect(requestsTo("/capture").filter((q) => q.requestId === `of-${(r as unknown as { id?: string }).id}-capture`).length).toBe(0);
    const attempt = await attemptOf(r.purchaseId);
    expect(requestsTo("/capture").filter((q) => q.requestId === `of-${attempt.id}-capture`)).toHaveLength(1);
  });

  it("five simultaneous accepts send exactly one capture", async () => {
    const r = await authorized();
    const results = await Promise.all(Array.from({ length: 5 }, () => decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx)));
    const attempt = await attemptOf(r.purchaseId);
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(requestsTo("/capture").filter((q) => q.requestId === `of-${attempt.id}-capture`)).toHaveLength(1);
    expect(attempt.state).toBe("CAPTURED");
  });

  it("demo step E: accept racing decline has one winner, never a capture and a void together", async () => {
    const r = await authorized();
    const [a, d] = await Promise.all([
      decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx),
      decide(db, deps(), r.actor, r.purchaseId, "declined", { reason: "Cannot make it in time." }, ctx),
    ]);
    expect([a.ok, d.ok].filter(Boolean)).toHaveLength(1);
    const attempt = await attemptOf(r.purchaseId);
    const captured = requestsTo("/capture").filter((q) => q.requestId === `of-${attempt.id}-capture`).length;
    const voided = requestsTo("/void").filter((q) => q.requestId === `of-${attempt.id}-void`).length;
    expect(captured + voided).toBe(1);
    expect(attempt.state).toBe(a.ok ? "CAPTURED" : "VOIDED");
  });

  it("only the merchant that owns the purchase can decide", async () => {
    const r = await authorized();
    const stranger: MerchantActor = { kind: "merchant", userId: randomUUID(), merchantId: (await freshMerchant(db)).merchantId };
    expect(await decide(db, deps(), stranger, r.purchaseId, "accepted", {}, ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect((await attemptOf(r.purchaseId)).state).toBe("AUTHORIZED");
  });
});

describe("decide: decline (demo step D)", () => {
  it("needs a reason, then voids, releases the stock and never captures", async () => {
    const r = await authorized();
    expect(await decide(db, deps(), r.actor, r.purchaseId, "declined", {}, ctx)).toMatchObject({ ok: false, code: "REASON_REQUIRED" });
    expect(requestsTo("/void")).toBeDefined();
    const before = requestsTo("/void").length;

    expect(await decide(db, deps(), r.actor, r.purchaseId, "declined", { reason: "Cannot make it in time." }, ctx)).toEqual({ ok: true, value: { decision: "declined", state: "VOIDED" } });
    const attempt = await attemptOf(r.purchaseId);
    expect(attempt.state).toBe("VOIDED");
    expect(requestsTo("/void").length).toBe(before + 1);
    expect(requestsTo("/void").at(-1)!.requestId).toBe(`of-${attempt.id}-void`);
    expect(await decisionOf(r.purchaseId)).toMatchObject({ decision: "declined", reason: "Cannot make it in time." });
    expect(await reservationOf(r.purchaseId)).toMatchObject({ state: "RELEASED", release_reason: "DECLINED" });
    expect(await desk(r)).toEqual({ on_hand: 100, reserved: 0 });
    expect(fake.authorizations.get(attempt.authorization_id!)!.status).toBe("VOIDED");
  });

  it("a void on an authorization that was already captured is a financial exception, never VOIDED", async () => {
    const r = await authorized();
    const attempt = await attemptOf(r.purchaseId);
    await paypal.captureAuthorization(attempt.authorization_id!, "of-outside-capture-1", { amount: cents(108000), finalCapture: true });
    const result = await decide(db, deps(), r.actor, r.purchaseId, "declined", { reason: "Changed my mind." }, ctx);
    expect(result).toMatchObject({ ok: false, code: "FINANCIAL_EXCEPTION", reasons: ["STATUS_NOT_AS_EXPECTED"] });
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "EXCEPTION", exception_reason: "STATUS_NOT_AS_EXPECTED" });
    expect((await reservationOf(r.purchaseId))!.state).toBe("REVIEW_REQUIRED");
    expect(await desk(r)).toEqual({ on_hand: 100, reserved: 30 });
  });
});

describe("decide: how a capture can go wrong", () => {
  it("a capture for the wrong amount is a financial exception: not paid, stock held", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "status", status: 201, body: { id: "CAP-WRONG-AMOUNT", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } } });
    const result = await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    expect(result).toMatchObject({ ok: false, code: "FINANCIAL_EXCEPTION" });
    expect(result.ok === false && result.reasons).toContain("AMOUNT_MISMATCH");
    expect((await attemptOf(r.purchaseId)).state).toBe("EXCEPTION");
    expect(await desk(r)).toEqual({ on_hand: 100, reserved: 30 });
    expect(await reservationOf(r.purchaseId)).toMatchObject({ state: "REVIEW_REQUIRED" });
  });

  it("a capture that is not COMPLETED is not paid", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "status", status: 201, body: { id: "CAP-PENDING", status: "PENDING", amount: { currency_code: "USD", value: "1080.00" } } });
    const result = await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    expect(result.ok === false && result.reasons).toContain("STATUS_NOT_AS_EXPECTED");
    expect((await attemptOf(r.purchaseId)).state).toBe("EXCEPTION");
  });

  it("with a payee configured, a capture paid to another merchant is an exception; to ours, it is paid", async () => {
    const wrong = await authorized();
    const bad = await decide(db, deps({ payeeMerchantId: "SOMEONEELSE" }), wrong.actor, wrong.purchaseId, "accepted", {}, ctx);
    expect(bad).toMatchObject({ ok: false, code: "FINANCIAL_EXCEPTION", reasons: ["PAYEE_MISMATCH"] });
    expect((await attemptOf(wrong.purchaseId)).state).toBe("EXCEPTION");

    const right = await authorized();
    expect((await decide(db, deps({ payeeMerchantId: FAKE_PAYEE }), right.actor, right.purchaseId, "accepted", {}, ctx)).ok).toBe(true);
    expect((await attemptOf(right.purchaseId)).state).toBe("CAPTURED");
  });

  it("PayPal refusing the capture returns the order to AUTHORIZED, the decision stays recorded and the stock stays held", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "status", status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "no", details: [{ issue: "PAYEE_ACCOUNT_RESTRICTED" }] } });
    expect(await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx)).toMatchObject({ ok: false, code: "PROVIDER_REFUSED", cause: "PAYEE_ACCOUNT_RESTRICTED" });
    expect((await attemptOf(r.purchaseId)).state).toBe("AUTHORIZED");
    expect(await decisionOf(r.purchaseId)).toMatchObject({ decision: "accepted" });
    expect((await reservationOf(r.purchaseId))!.state).toBe("AWAITING_CONFIRMATION");
    expect(await desk(r)).toEqual({ on_hand: 100, reserved: 30 });
  });

  it("a capture answer lost after PayPal processed it is OUTCOME_UNKNOWN: no second capture is sent, stock held for review", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "drop-after" });
    expect(await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    const attempt = await attemptOf(r.purchaseId);
    expect(attempt).toMatchObject({ state: "OUTCOME_UNKNOWN", unknown_operation: "capture" });
    expect((await reservationOf(r.purchaseId))!.state).toBe("REVIEW_REQUIRED");
    expect(await desk(r)).toEqual({ on_hand: 100, reserved: 30 });
    expect(await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx)).toMatchObject({ ok: false, code: "DECISION_ALREADY_MADE" });
    expect(requestsTo("/capture").filter((q) => q.requestId === `of-${attempt.id}-capture`)).toHaveLength(1);
  });

  it("a capture that times out is OUTCOME_UNKNOWN too", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "hang" });
    expect(await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect((await attemptOf(r.purchaseId)).unknown_operation).toBe("capture");
  });

  it("a void answer lost is OUTCOME_UNKNOWN for the void", async () => {
    const r = await authorized();
    fake.inject("/void", { type: "drop-after" });
    expect(await decide(db, deps(), r.actor, r.purchaseId, "declined", { reason: "No." }, ctx)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "OUTCOME_UNKNOWN", unknown_operation: "void" });
  });

  it("a capture rate limited by PayPal never took effect: back to AUTHORIZED, can be retried by reconciliation", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "status", status: 429, body: { name: "RATE_LIMIT_REACHED", message: "slow down" } });
    expect(await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx)).toMatchObject({ ok: false, code: "PROVIDER_UNREACHABLE" });
    expect((await attemptOf(r.purchaseId)).state).toBe("AUTHORIZED");
  });
});

describe("a change after authorization (demo step H)", () => {
  it("a superseded quote blocks the capture, and the authorization can still be voided", async () => {
    const r = await authorized();
    must(await db.from("quote_versions").update({ status: "SUPERSEDED" }).eq("id", r.quoteId));
    const before = captureCalls();
    expect(await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx)).toMatchObject({ ok: false, code: "CAPTURE_BLOCKED", cause: "SUPERSEDED" });
    expect(captureCalls()).toBe(before);
    expect(await decisionOf(r.purchaseId)).toMatchObject({ decision: "pending" });

    expect(await voidForChange(db, deps(), r.actor, r.purchaseId, "The customer changed the order.", ctx)).toEqual({ ok: true, value: { state: "VOIDED" } });
    expect(await reservationOf(r.purchaseId)).toMatchObject({ state: "RELEASED", release_reason: "VOIDED" });
    expect(await desk(r)).toEqual({ on_hand: 100, reserved: 0 });
    // The old authorization is never reused: the superseded quote cannot be paid again.
    expect(await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: "http://localhost:3100/o/TOKEN" }, ctx)).toMatchObject({ ok: false, code: "QUOTE_NOT_ACCEPTED" });
  });

  it("once the money is captured, a change is refused as ALREADY_CAPTURED and nothing is sent", async () => {
    const r = await authorized();
    await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    const voids = requestsTo("/void").length;
    const result = await voidForChange(db, deps(), r.actor, r.purchaseId, "Too late.", ctx);
    expect(result).toMatchObject({ ok: false, code: "ALREADY_CAPTURED" });
    expect(requestsTo("/void").length).toBe(voids);
    expect((await attemptOf(r.purchaseId)).state).toBe("CAPTURED");
  });

  it("a purchase of another merchant is not found", async () => {
    const r = await authorized();
    const stranger: MerchantActor = { kind: "merchant", userId: randomUUID(), merchantId: (await freshMerchant(db)).merchantId };
    expect(await voidForChange(db, deps(), stranger, r.purchaseId, "x", ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
