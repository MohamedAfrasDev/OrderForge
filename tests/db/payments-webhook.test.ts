// Real local Postgres, the real webhook handler and store, and the LOCAL FAKE PayPal. The signature check is stubbed
// (MOCKED) and redelivery is REPLAYED. Nothing here is real-sandbox evidence.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPayPalClient } from "@/lib/paypal/client";
import type { PayPalResult } from "@/lib/paypal/types";
import { handlePayPalWebhook, type WebhookDeps } from "@/lib/paypal/webhook-handler";
import { recordPaymentEvent } from "@/lib/paypal/webhook-store";
import { completeApproval, startCheckout } from "@/services/payments/checkout";
import { decide } from "@/services/payments/decide";
import { beginPayment } from "@/services/payments/settle";
import type { PayPalPort } from "@/services/payments/shared";
import { applyWebhookEvent } from "@/services/payments/webhook";
import type { MerchantActor } from "@/services/quote/shared";
import { startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { acceptedPurchase, freshMerchant, type AcceptedPurchase, type Merchant } from "./accepted-purchase";
import { must, serviceClient } from "./helpers";
import { T0 } from "./payments-helpers";
import { expectStockConsistentAtEnd, stockOf } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

let fake: FakePayPal;
let paypal: PayPalPort;
const ctx = { now: T0, correlationId: "corr-payments-t8" };
const RETURN = "http://localhost:3100/o/TOKEN";
const HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42",
  "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "paypal-transmission-sig": "lmI95Jx3Y9nhR5SJWlHVIWpg4AgWTjkPmLNfLvMbFBI=",
  "paypal-transmission-time": "2026-11-03T10:00:00Z",
};

beforeAll(async () => {
  fake = await startFakePayPal();
  paypal = makeClient();
});
afterAll(async () => {
  await fake.close();
});

function makeClient(): PayPalPort {
  return createPayPalClient({ env: "sandbox", clientId: "test-client", clientSecret: "test-secret-0000000000", baseUrl: fake.url, timeoutMs: 400 });
}
const deps = (client: PayPalPort = paypal) => ({ paypal: client, evidence: "mocked" as const });
const requestsTo = (match: string) => fake.requests.filter((r) => `${r.method} ${r.path}`.includes(match));

type Ready = AcceptedPurchase & { m: Merchant; actor: MerchantActor; attemptId: string; orderId: string };
const attemptOf = async (purchaseId: string) =>
  must(await db.from("payment_attempts").select("id, state, paypal_order_id, authorization_id, capture_id").eq("purchase_id", purchaseId).order("created_at", { ascending: false }).limit(1).single()) as {
    id: string; state: string; paypal_order_id: string | null; authorization_id: string | null; capture_id: string | null;
  };

async function checkout(): Promise<Ready> {
  const m = await freshMerchant(db);
  const p = await acceptedPurchase(db, m);
  const started = await startCheckout(db, deps(), p.who, p.purchaseId, { returnUrl: RETURN }, ctx);
  if (!started.ok) throw new Error(`startCheckout: ${started.code}`);
  const attempt = await attemptOf(p.purchaseId);
  return { ...p, m, actor: { kind: "merchant", userId: randomUUID(), merchantId: m.merchantId }, attemptId: attempt.id, orderId: attempt.paypal_order_id! };
}
async function authorized(): Promise<Ready> {
  const r = await checkout();
  fake.approve(r.orderId);
  const done = await completeApproval(db, deps(), r.who, r.orderId, ctx);
  if (!done.ok) throw new Error(`completeApproval: ${done.code}`);
  return r;
}

type EventSpec = { type: string; resourceType: string; resourceId: string; status?: string; orderId?: string; authorizationId?: string; amount?: string };
function eventBody(id: string, e: EventSpec): string {
  return JSON.stringify({
    id,
    event_type: e.type,
    resource_type: e.resourceType,
    create_time: "2026-11-03T10:00:00Z",
    resource: {
      id: e.resourceId,
      status: e.status ?? "COMPLETED",
      ...(e.amount ? { amount: { currency_code: "USD", value: e.amount } } : {}),
      supplementary_data: { related_ids: { ...(e.orderId ? { order_id: e.orderId } : {}), ...(e.authorizationId ? { authorization_id: e.authorizationId } : {}) } },
      payer: { email_address: "buyer@example.com" },
    },
  });
}
const newEventId = () => `WH-${randomUUID()}`;

function handlerDeps(overrides: Partial<WebhookDeps> = {}, applyDeps = deps(), now = T0): WebhookDeps {
  return {
    webhookId: "WH-TEST-0001",
    verifySignature: async (): Promise<PayPalResult<{ verified: boolean }>> => ({ kind: "ok", data: { verified: true } }),
    record: (row) => recordPaymentEvent(db, row),
    apply: (eventId) => applyWebhookEvent(db, applyDeps, eventId, { ...ctx, now }),
    evidenceLabel: "mocked",
    ...overrides,
  };
}
const deliver = (body: string, d: WebhookDeps) => handlePayPalWebhook(new Request("http://localhost/api/webhooks/paypal", { method: "POST", body, headers: HEADERS }), d);
const eventRow = async (id: string) => must(await db.from("payment_events").select("id, payment_attempt_id, processed_at, payload, evidence_label, source").eq("provider_event_id", id).single()) as {
  id: string; payment_attempt_id: string | null; processed_at: string | null; payload: Record<string, unknown>; evidence_label: string; source: string;
};

describe("a webhook is a hint, and PayPal is asked what is true", () => {
  it("an approval event makes us ask PayPal, which confirms, so the attempt becomes APPROVED and the event is linked and processed", async () => {
    const r = await checkout();
    fake.approve(r.orderId);
    const id = newEventId();
    const response = await deliver(eventBody(id, { type: "CHECKOUT.ORDER.APPROVED", resourceType: "checkout-order", resourceId: r.orderId, status: "APPROVED" }), handlerDeps());
    expect(response.status).toBe(200);
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "APPROVED" });
    expect(await eventRow(id)).toMatchObject({ payment_attempt_id: r.attemptId, source: "webhook", evidence_label: "mocked" });
    expect((await eventRow(id)).processed_at).not.toBeNull();
  });

  it("the payload never sets state: a CAPTURE.COMPLETED event for money PayPal did not capture changes nothing", async () => {
    const r = await authorized();
    const attempt = await attemptOf(r.purchaseId);
    const id = newEventId();
    const captures = requestsTo("/capture").length;
    const response = await deliver(
      eventBody(id, { type: "PAYMENT.CAPTURE.COMPLETED", resourceType: "capture", resourceId: "CAP-FORGED", orderId: r.orderId, authorizationId: attempt.authorization_id!, amount: "1080.00" }),
      handlerDeps(),
    );
    expect(response.status).toBe(200);
    expect((await attemptOf(r.purchaseId)).state).toBe("AUTHORIZED");
    expect((await attemptOf(r.purchaseId)).capture_id).toBeNull();
    expect(requestsTo("/capture").length).toBe(captures);
    expect(await stockOf(db, r.m.product["ORGANIZER-DESK"]!)).toEqual({ on_hand: 100, reserved: 30 });
  });

  it("an uncertain capture is settled by the late event, from PayPal's records, with no second capture", async () => {
    const r = await authorized();
    fake.inject("/capture", { type: "drop-after" });
    await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    expect((await attemptOf(r.purchaseId)).state).toBe("OUTCOME_UNKNOWN");
    const attempt = await attemptOf(r.purchaseId);

    const id = newEventId();
    await deliver(eventBody(id, { type: "PAYMENT.CAPTURE.COMPLETED", resourceType: "capture", resourceId: "CAP-X", orderId: r.orderId, authorizationId: attempt.authorization_id! }), handlerDeps());
    expect((await attemptOf(r.purchaseId)).state).toBe("CAPTURED");
    expect(requestsTo("/capture").filter((q) => q.requestId === `of-${r.attemptId}-capture`)).toHaveLength(1);
  });

  it("an event for an id we do not know is stored and ignored", async () => {
    const id = newEventId();
    const response = await deliver(eventBody(id, { type: "PAYMENT.CAPTURE.COMPLETED", resourceType: "capture", resourceId: "CAP-UNKNOWN", orderId: "NOSUCHORDER", authorizationId: "NOSUCHAUTH" }), handlerDeps());
    expect(response.status).toBe(200);
    const row = await eventRow(id);
    expect(row.payment_attempt_id).toBeNull();
    expect(row.processed_at).not.toBeNull();
  });

  it("an out-of-order event (AUTHORIZATION.CREATED after the capture) never moves the attempt backwards", async () => {
    const r = await authorized();
    await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    const attempt = await attemptOf(r.purchaseId);
    expect(attempt.state).toBe("CAPTURED");
    const id = newEventId();
    await deliver(eventBody(id, { type: "PAYMENT.AUTHORIZATION.CREATED", resourceType: "authorization", resourceId: attempt.authorization_id!, orderId: r.orderId, status: "CREATED" }), handlerDeps());
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "CAPTURED", capture_id: attempt.capture_id });
    expect((await eventRow(id)).processed_at).not.toBeNull();
  });

  it("an operation we started moments ago is left to the code sending it (deferred), not settled from here", async () => {
    const r = await checkout();
    fake.approve(r.orderId);
    must(await db.rpc("payment_mark_approved", { p_attempt_id: r.attemptId, p_now: T0 }));
    expect((await beginPayment(db, r.attemptId, "authorize", T0)).ok).toBe(true);
    const id = newEventId();
    const reads = requestsTo("GET").length;
    await deliver(eventBody(id, { type: "CHECKOUT.ORDER.APPROVED", resourceType: "checkout-order", resourceId: r.orderId, status: "APPROVED" }), handlerDeps({}, deps(), new Date(Date.parse(T0) + 10_000).toISOString()));
    expect((await attemptOf(r.purchaseId)).state).toBe("AUTHORIZE_IN_FLIGHT");
    expect(requestsTo("GET").length).toBe(reads);
  });
});

describe("redelivery (replayed)", () => {
  it("a processed event delivered again is acknowledged with no second effect", async () => {
    const r = await checkout();
    fake.approve(r.orderId);
    const id = newEventId();
    const body = eventBody(id, { type: "CHECKOUT.ORDER.APPROVED", resourceType: "checkout-order", resourceId: r.orderId, status: "APPROVED" });
    await deliver(body, handlerDeps());
    const reads = fake.requests.length;
    const again = await deliver(body, handlerDeps());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "duplicate" });
    expect(fake.requests.length).toBe(reads);
  });

  it("a stored event that could not be processed is answered 500, then processed when PayPal redelivers it", async () => {
    const r = await checkout();
    fake.approve(r.orderId);
    const id = newEventId();
    const body = eventBody(id, { type: "CHECKOUT.ORDER.APPROVED", resourceType: "checkout-order", resourceId: r.orderId, status: "APPROVED" });
    const broken: PayPalPort = { ...paypal, getOrder: async () => { throw new Error("PayPal read failed"); }, createOrder: paypal.createOrder, authorizeOrder: paypal.authorizeOrder, captureAuthorization: paypal.captureAuthorization, voidAuthorization: paypal.voidAuthorization, getAuthorization: paypal.getAuthorization, getCapture: paypal.getCapture };

    const first = await deliver(body, handlerDeps({}, deps(broken)));
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({ error: "processing_failed" });
    expect((await eventRow(id)).processed_at).toBeNull();
    expect((await attemptOf(r.purchaseId)).state).toBe("PROVIDER_CREATED");

    const second = await deliver(body, handlerDeps());
    expect(second.status).toBe(200);
    expect((await eventRow(id)).processed_at).not.toBeNull();
    expect((await attemptOf(r.purchaseId)).state).toBe("APPROVED");
  });

  it("five simultaneous deliveries of one event have one effect", async () => {
    const r = await checkout();
    fake.approve(r.orderId);
    const id = newEventId();
    const body = eventBody(id, { type: "CHECKOUT.ORDER.APPROVED", resourceType: "checkout-order", resourceId: r.orderId, status: "APPROVED" });
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(body, handlerDeps())));
    expect(results.map((x) => x.status)).toEqual([200, 200, 200, 200, 200]);
    expect((await attemptOf(r.purchaseId)).state).toBe("APPROVED");
    expect(must(await db.from("payment_events").select("id").eq("provider_event_id", id))).toHaveLength(1);
  });
});

describe("forged deliveries are still rejected", () => {
  it("a delivery PayPal does not vouch for is rejected, stored nowhere and acted on never", async () => {
    const r = await checkout();
    fake.approve(r.orderId);
    const id = newEventId();
    const response = await deliver(
      eventBody(id, { type: "CHECKOUT.ORDER.APPROVED", resourceType: "checkout-order", resourceId: r.orderId, status: "APPROVED" }),
      handlerDeps({ verifySignature: async () => ({ kind: "ok", data: { verified: false } }) }),
    );
    expect(response.status).toBe(400);
    expect(must(await db.from("payment_events").select("id").eq("provider_event_id", id))).toHaveLength(0);
    expect((await attemptOf(r.purchaseId)).state).toBe("PROVIDER_CREATED");
  });
});

describe("applyWebhookEvent", () => {
  it("refuses an event that was never stored", async () => {
    await expect(applyWebhookEvent(db, deps(), newEventId(), ctx)).rejects.toThrow(/not stored/);
  });
});
