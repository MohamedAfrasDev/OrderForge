// Real local Postgres and the LOCAL FAKE PayPal. Every PayPal answer here is mocked evidence: it proves our wiring,
// never PayPal's real behaviour. Evidence label for this file: mocked.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPayPalClient } from "@/lib/paypal/client";
import { startCheckout, completeApproval } from "@/services/payments/checkout";
import type { PayPalPort } from "@/services/payments/shared";
import { startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { acceptedPurchase, freshMerchant, verifiedFor, type AcceptedPurchase, type Merchant } from "./accepted-purchase";
import { must, serviceClient } from "./helpers";
import { T0 } from "./payments-helpers";
import { addMinutes, expectStockConsistentAtEnd, stockOf } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

let fake: FakePayPal;
let paypal: PayPalPort;
const RETURN_URL = "http://localhost:3100/o/TOKEN";
const ctx = { now: T0, correlationId: "corr-payments-t5" };

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
const requestsTo = (match: string) => fake.requests.filter((r) => `${r.method} ${r.path}`.includes(match));

type Ready = AcceptedPurchase & { m: Merchant };
async function ready(opts: { boxCount?: number; conditions?: unknown[] } = {}): Promise<Ready> {
  const m = await freshMerchant(db);
  return { ...(await acceptedPurchase(db, m, opts)), m };
}

const attemptOf = async (purchaseId: string) =>
  must(await db.from("payment_attempts").select("id, state, paypal_order_id, authorization_id, approve_url, failure_code, exception_reason, unknown_operation, amount_minor, currency, quote_hash").eq("purchase_id", purchaseId).order("created_at", { ascending: false }).limit(1).single()) as {
    id: string; state: string; paypal_order_id: string | null; authorization_id: string | null; approve_url: string | null;
    failure_code: string | null; exception_reason: string | null; unknown_operation: string | null; amount_minor: number; currency: string; quote_hash: string;
  };
const attemptCount = async (purchaseId: string) => must(await db.from("payment_attempts").select("id").eq("purchase_id", purchaseId)).length;
const reservationOf = async (purchaseId: string) => (await db.from("reservations").select("state, expires_at, release_reason").eq("purchase_id", purchaseId).maybeSingle()).data as { state: string; expires_at: string | null; release_reason: string | null } | null;
const decisionOf = async (purchaseId: string) => (await db.from("merchant_decisions").select("decision, authorization_id").eq("purchase_id", purchaseId).maybeSingle()).data as { decision: string; authorization_id: string } | null;
const eventsOf = async (attemptId: string) => must(await db.from("payment_events").select("event_type, source, evidence_label, payload").eq("payment_attempt_id", attemptId).order("created_at")) as Array<{ event_type: string; source: string; evidence_label: string; payload: Record<string, unknown> }>;
const auditOf = async (attemptId: string) => must(await db.from("audit_events").select("action, actor, data").eq("entity", "payment_attempt").eq("entity_id", attemptId).order("id")) as Array<{ action: string; actor: string; data: Record<string, unknown> }>;

/** Start checkout and approve the order at the fake, as the sandbox buyer would. */
async function checkedOut(r: Ready, client: PayPalPort = paypal) {
  const started = await startCheckout(db, deps(client), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx);
  if (!started.ok) throw new Error(`startCheckout: ${started.code}`);
  const attempt = await attemptOf(r.purchaseId);
  fake.approve(attempt.paypal_order_id!);
  return { ...started.value, orderId: attempt.paypal_order_id! };
}

describe("startCheckout", () => {
  it("demo step A: holds the stock, creates an AUTHORIZE order for exactly the accepted total, and returns the approval link", async () => {
    const r = await ready();
    const result = await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx);
    expect(result).toMatchObject({ ok: true, value: { state: "PROVIDER_CREATED" } });
    if (!result.ok) return;

    const attempt = await attemptOf(r.purchaseId);
    expect(attempt).toMatchObject({ id: result.value.attemptId, state: "PROVIDER_CREATED", amount_minor: 108000, currency: "USD", quote_hash: r.quoteHash });
    expect(result.value.approveUrl).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${attempt.paypal_order_id}`);
    expect(attempt.approve_url).toBe(result.value.approveUrl);

    const call = requestsTo("POST /v2/checkout/orders").find((q) => q.path === "/v2/checkout/orders" && (q.body as { purchase_units?: Array<{ reference_id?: string }> })?.purchase_units?.[0]?.reference_id === attempt.id)!;
    expect(call).toBeTruthy();
    expect(call.requestId).toBe(`of-${attempt.id}-create`);
    const body = call.body as { intent: string; purchase_units: Array<{ reference_id: string; amount: { currency_code: string; value: string } }>; payment_source: { paypal: { experience_context: { return_url: string } } } };
    expect(body.intent).toBe("AUTHORIZE");
    expect(body.purchase_units[0]!.amount).toEqual({ currency_code: "USD", value: "1080.00" });
    expect(body.payment_source.paypal.experience_context.return_url).toBe(RETURN_URL);

    for (const sku of ["NOTEBOOK-A5", "PEN-BLK", "ORGANIZER-DESK", "CARD-BRANDED", "PACK-BOX"]) expect((await stockOf(db, r.m.product[sku]!)).reserved, sku).toBe(30);
    expect(await reservationOf(r.purchaseId)).toMatchObject({ state: "HELD" });
  });

  it("the amount comes only from the accepted snapshot: a catalog price change afterwards changes nothing", async () => {
    const r = await ready();
    must(await db.from("products").update({ unit_price_minor: 1 }).eq("id", r.m.product["ORGANIZER-DESK"]!));
    const result = await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx);
    expect(result.ok).toBe(true);
    expect((await attemptOf(r.purchaseId)).amount_minor).toBe(108000);
    const order = requestsTo("POST /v2/checkout/orders").at(-1)!;
    expect((order.body as { purchase_units: Array<{ amount: { value: string } }> }).purchase_units[0]!.amount.value).toBe("1080.00");
  });

  it("stores the order as mocked evidence with an allowlisted summary, and audits the steps", async () => {
    const r = await ready();
    const result = await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx);
    const attemptId = result.ok ? result.value.attemptId : "";
    const events = await eventsOf(attemptId);
    expect(events.map((e) => e.event_type)).toEqual(["payment.order_created"]);
    expect(events[0]).toMatchObject({ source: "api", evidence_label: "mocked" });
    expect(Object.keys(events[0]!.payload).sort()).toEqual(["amount_minor", "currency", "order_id", "request_id", "status"]);
    expect(events[0]!.payload).toMatchObject({ amount_minor: 108000, currency: "USD", request_id: `of-${attemptId}-create` });

    const audit = await auditOf(attemptId);
    expect(audit.map((a) => a.action)).toEqual(["payment.attempt_created", "payment.order_created"]);
    expect(audit[0]).toMatchObject({ actor: `customer:${r.inquiryId}` });
    for (const a of audit) for (const key of Object.keys(a.data)) expect(["payment_attempt_id", "purchase_id", "amount_minor", "currency", "state", "from", "to", "operation", "quote_hash"]).toContain(key);
  });

  it("resumes an unfinished checkout instead of making another order", async () => {
    const r = await ready();
    const first = await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx);
    const again = await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx);
    expect(first.ok && again.ok && again.value).toMatchObject({ attemptId: first.ok ? first.value.attemptId : "", approveUrl: first.ok ? first.value.approveUrl : "" });
    expect(await attemptCount(r.purchaseId)).toBe(1);
    expect(requestsTo("POST /v2/checkout/orders").filter((q) => q.path === "/v2/checkout/orders" && (q.body as { purchase_units: Array<{ reference_id: string }> }).purchase_units[0]!.reference_id === (first.ok ? first.value.attemptId : ""))).toHaveLength(1);
  });

  it("an approved checkout resumes as APPROVED with no link: the customer only has to finish", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    expect((await completeApproval(db, deps(), r.who, out.orderId, ctx)).ok).toBe(true); // approved and authorized
    const again = await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx);
    expect(again).toMatchObject({ ok: false, code: "ATTEMPT_ACTIVE" });
  });

  it("refuses another customer's purchase, creating nothing", async () => {
    const r = await ready();
    const stranger = await ready();
    expect(await startCheckout(db, deps(), stranger.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx)).toMatchObject({ ok: false, code: "PURCHASE_NOT_FOUND" });
    expect(await attemptCount(r.purchaseId)).toBe(0);
    expect(await reservationOf(r.purchaseId)).toBeNull();
  });

  it("refuses a quote that is no longer accepted, with nothing held and nothing sent to PayPal", async () => {
    const r = await ready();
    must(await db.from("quote_versions").update({ status: "SUPERSEDED" }).eq("id", r.quoteId));
    const before = fake.requests.length;
    expect(await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx)).toMatchObject({ ok: false, code: "QUOTE_NOT_ACCEPTED", cause: "SUPERSEDED" });
    expect(await attemptCount(r.purchaseId)).toBe(0);
    expect(await reservationOf(r.purchaseId)).toBeNull();
    expect(fake.requests.length).toBe(before);
  });

  it("refuses when the stock is gone: nothing held, no attempt, nothing sent", async () => {
    const r = await ready();
    must(await db.from("stock").update({ on_hand: 20 }).eq("product_id", r.m.product["ORGANIZER-DESK"]!));
    const before = fake.requests.length;
    expect(await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx)).toMatchObject({ ok: false, code: "RESERVATION_REFUSED", cause: "INSUFFICIENT_STOCK" });
    expect(await attemptCount(r.purchaseId)).toBe(0);
    expect(fake.requests.length).toBe(before);
  });

  it("PayPal refusing the order ends the attempt with a code and keeps the hold; the customer can start again", async () => {
    const r = await ready();
    fake.inject("POST /v2/checkout/orders", { type: "status", status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "bad", details: [{ issue: "INVALID_REQUEST" }] } });
    expect(await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx)).toMatchObject({ ok: false, code: "PROVIDER_REFUSED", cause: "INVALID_REQUEST" });
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "FAILED", failure_code: "INVALID_REQUEST" });
    expect((await reservationOf(r.purchaseId))!.state).toBe("HELD");

    const again = await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx);
    expect(again.ok).toBe(true);
    expect(await attemptCount(r.purchaseId)).toBe(2);
  });

  it("a lost answer to the order creation is safe to repeat: the same request id gives the same single order", async () => {
    const r = await ready();
    const ordersBefore = fake.orders.size;
    fake.inject("POST /v2/checkout/orders", { type: "drop-after" });
    expect(await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx)).toMatchObject({ ok: false, code: "PROVIDER_UNREACHABLE" });
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "CREATED", paypal_order_id: null });
    expect(fake.orders.size).toBe(ordersBefore + 1); // PayPal did create it

    const retry = await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx);
    expect(retry.ok).toBe(true);
    expect(fake.orders.size).toBe(ordersBefore + 1); // and the retry did not make a second
    const creates = requestsTo("POST /v2/checkout/orders").filter((q) => q.path === "/v2/checkout/orders" && q.requestId?.startsWith(`of-${retry.ok ? retry.value.attemptId : ""}-create`));
    expect(creates).toHaveLength(2);
    expect(new Set(creates.map((c) => c.requestId)).size).toBe(1);
    expect(await attemptCount(r.purchaseId)).toBe(1);
  });

  it("an unreachable PayPal (no access token) leaves the attempt as CREATED and nothing is lost", async () => {
    const r = await ready();
    const broken = makeClient((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/oauth2/token")) throw new TypeError("network down");
      return fetch(input, init);
    }) as typeof fetch);
    expect(await startCheckout(db, deps(broken), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx)).toMatchObject({ ok: false, code: "PROVIDER_UNREACHABLE" });
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "CREATED" });
    expect((await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx)).ok).toBe(true);
  });

  it("rejects a return URL that is not https (or local http)", async () => {
    const r = await ready();
    await expect(startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: "http://evil.example.com/o/x" }, ctx)).rejects.toThrow();
  });
});

describe("completeApproval: demo step B", () => {
  it("does not trust the return: an order PayPal does not show as approved is NOT_APPROVED and nothing changes", async () => {
    const r = await ready();
    const started = await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx);
    const orderId = (await attemptOf(r.purchaseId)).paypal_order_id!;
    expect(started.ok).toBe(true);
    const before = requestsTo("/authorize").length;
    expect(await completeApproval(db, deps(), r.who, orderId, ctx)).toMatchObject({ ok: false, code: "NOT_APPROVED" });
    expect((await attemptOf(r.purchaseId)).state).toBe("PROVIDER_CREATED");
    expect(requestsTo("/authorize").length).toBe(before);
  });

  it("verifies approval with PayPal, then authorizes: AUTHORIZED, the merchant decision is pending, the reservation awaits", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    const done = await completeApproval(db, deps(), r.who, out.orderId, ctx);
    expect(done).toMatchObject({ ok: true, value: { state: "AUTHORIZED", already: false } });

    const attempt = await attemptOf(r.purchaseId);
    expect(attempt.state).toBe("AUTHORIZED");
    expect(attempt.authorization_id).toMatch(/^FAKEAUTH/);
    expect(await reservationOf(r.purchaseId)).toMatchObject({ state: "AWAITING_CONFIRMATION" });
    expect(await decisionOf(r.purchaseId)).toMatchObject({ decision: "pending", authorization_id: attempt.authorization_id });

    const authorize = requestsTo("/authorize").filter((q) => q.path.includes(out.orderId));
    expect(authorize).toHaveLength(1);
    expect(authorize[0]!.requestId).toBe(`of-${attempt.id}-authorize`);

    expect((await eventsOf(attempt.id)).map((e) => e.event_type)).toEqual(["payment.order_created", "payment.order_approved", "payment.authorized"]);
    expect((await eventsOf(attempt.id)).every((e) => e.evidence_label === "mocked" && e.source === "api")).toBe(true);
    expect((await auditOf(attempt.id)).map((a) => a.action)).toEqual(["payment.attempt_created", "payment.order_created", "payment.order_approved", "payment.authorize_begun", "payment.authorized"]);
    expect(await stockOf(db, r.m.product["ORGANIZER-DESK"]!)).toEqual({ on_hand: 100, reserved: 30 });
  });

  it("repeating the finish is a no-op: no second authorize reaches PayPal", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    await completeApproval(db, deps(), r.who, out.orderId, ctx);
    expect(await completeApproval(db, deps(), r.who, out.orderId, ctx)).toMatchObject({ ok: true, value: { state: "AUTHORIZED", already: true } });
    expect(requestsTo("/authorize").filter((q) => q.path.includes(out.orderId))).toHaveLength(1);
  });

  it("five simultaneous finishes send exactly one authorize to PayPal", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    const results = await Promise.all(Array.from({ length: 5 }, () => completeApproval(db, deps(), r.who, out.orderId, ctx)));
    expect(requestsTo("/authorize").filter((q) => q.path.includes(out.orderId))).toHaveLength(1);
    expect(results.some((x) => x.ok && x.value.state === "AUTHORIZED")).toBe(true);
    expect((await attemptOf(r.purchaseId)).state).toBe("AUTHORIZED");
    expect(await reservationOf(r.purchaseId)).toMatchObject({ state: "AWAITING_CONFIRMATION" });
  });

  it("refuses an order id that belongs to another customer's purchase", async () => {
    const r = await ready();
    const other = await ready();
    const out = await checkedOut(other);
    expect(await completeApproval(db, deps(), r.who, out.orderId, ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect((await attemptOf(other.purchaseId)).state).toBe("PROVIDER_CREATED");
    expect(await completeApproval(db, deps(), r.who, "NOT-AN-ORDER", ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await completeApproval(db, deps(), r.who, "bad id with spaces", ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("an order PayPal reports void ends the attempt", async () => {
    const r = await ready();
    await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx);
    const orderId = (await attemptOf(r.purchaseId)).paypal_order_id!;
    fake.inject(`GET /v2/checkout/orders/${orderId}`, { type: "status", status: 200, body: { id: orderId, status: "VOIDED" } });
    expect(await completeApproval(db, deps(), r.who, orderId, ctx)).toMatchObject({ ok: false, code: "PROVIDER_REFUSED" });
    expect((await attemptOf(r.purchaseId)).state).toBe("FAILED");
  });

  it("an expired hold at authorize time sends nothing to PayPal and expires the attempt", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    const before = requestsTo("/authorize").length;
    const result = await completeApproval(db, deps(), r.who, out.orderId, { ...ctx, now: addMinutes(T0, 31) });
    expect(result).toMatchObject({ ok: false, code: "RESERVATION_REFUSED", cause: "HOLD_EXPIRED" });
    expect((await attemptOf(r.purchaseId)).state).toBe("EXPIRED");
    expect(requestsTo("/authorize").length).toBe(before);
    expect(await stockOf(db, r.m.product["ORGANIZER-DESK"]!)).toEqual({ on_hand: 100, reserved: 0 });
  });
});

describe("completeApproval: how authorize can go wrong", () => {
  it("PayPal refuses the authorization: FAILED with PayPal's reason, the hold restarts, the customer can try again", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    fake.inject("/authorize", { type: "status", status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "declined", details: [{ issue: "INSTRUMENT_DECLINED" }] } });
    expect(await completeApproval(db, deps(), r.who, out.orderId, ctx)).toMatchObject({ ok: false, code: "PROVIDER_REFUSED", cause: "INSTRUMENT_DECLINED" });
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "FAILED", failure_code: "INSTRUMENT_DECLINED" });
    expect((await reservationOf(r.purchaseId))!.state).toBe("HELD");
    expect(await stockOf(db, r.m.product["ORGANIZER-DESK"]!)).toEqual({ on_hand: 100, reserved: 30 });
    expect((await startCheckout(db, deps(), r.who, r.purchaseId, { returnUrl: RETURN_URL }, ctx)).ok).toBe(true);
  });

  it("the answer is lost after PayPal authorized: OUTCOME_UNKNOWN, no retry, the reservation goes to review with stock held", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    fake.inject("/authorize", { type: "drop-after" });
    expect(await completeApproval(db, deps(), r.who, out.orderId, ctx)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "OUTCOME_UNKNOWN", unknown_operation: "authorize" });
    expect((await reservationOf(r.purchaseId))!.state).toBe("REVIEW_REQUIRED");
    expect(await stockOf(db, r.m.product["ORGANIZER-DESK"]!)).toEqual({ on_hand: 100, reserved: 30 });
    expect(requestsTo("/authorize").filter((q) => q.path.includes(out.orderId))).toHaveLength(1);
    // PayPal did authorize it; a later reconciliation finds that out. Here, finishing again must not send another authorize.
    expect(await completeApproval(db, deps(), r.who, out.orderId, ctx)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect(requestsTo("/authorize").filter((q) => q.path.includes(out.orderId))).toHaveLength(1);
  });

  it("an authorize that times out is OUTCOME_UNKNOWN too, never retried", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    fake.inject("/authorize", { type: "hang" });
    expect(await completeApproval(db, deps(), r.who, out.orderId, ctx)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect((await attemptOf(r.purchaseId)).unknown_operation).toBe("authorize");
  });

  it("an authorize PayPal refuses to process yet (rate limited) never took effect: back to APPROVED, hold restarted, can be retried", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    fake.inject("/authorize", { type: "status", status: 429, body: { name: "RATE_LIMIT_REACHED", message: "slow down" } });
    expect(await completeApproval(db, deps(), r.who, out.orderId, ctx)).toMatchObject({ ok: false, code: "PROVIDER_UNREACHABLE" });
    expect((await attemptOf(r.purchaseId)).state).toBe("APPROVED");
    expect((await reservationOf(r.purchaseId))!.state).toBe("HELD");
    expect(await completeApproval(db, deps(), r.who, out.orderId, ctx)).toMatchObject({ ok: true, value: { state: "AUTHORIZED" } });
  });

  it("demo step G: an authorization for the wrong amount is a financial exception: never paid, stock held, no decision to make", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    fake.inject("/authorize", {
      type: "status",
      status: 201,
      body: { id: out.orderId, status: "COMPLETED", purchase_units: [{ payments: { authorizations: [{ id: "AUTH-WRONG-AMOUNT", status: "CREATED", amount: { currency_code: "USD", value: "1.00" } }] } }] },
    });
    expect(await completeApproval(db, deps(), r.who, out.orderId, ctx)).toMatchObject({ ok: false, code: "FINANCIAL_EXCEPTION", reasons: ["AMOUNT_MISMATCH"] });
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "EXCEPTION", exception_reason: "AMOUNT_MISMATCH", authorization_id: "AUTH-WRONG-AMOUNT" });
    expect((await reservationOf(r.purchaseId))!.state).toBe("REVIEW_REQUIRED");
    expect(await stockOf(db, r.m.product["ORGANIZER-DESK"]!)).toEqual({ on_hand: 100, reserved: 30 });
    expect(await decisionOf(r.purchaseId)).toBeNull();
  });

  it("an authorization in another currency is a financial exception too", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    fake.inject("/authorize", {
      type: "status",
      status: 201,
      body: { id: out.orderId, status: "COMPLETED", purchase_units: [{ payments: { authorizations: [{ id: "AUTH-EUR", status: "CREATED", amount: { currency_code: "EUR", value: "1080.00" } }] } }] },
    });
    expect(await completeApproval(db, deps(), r.who, out.orderId, ctx)).toMatchObject({ ok: false, code: "FINANCIAL_EXCEPTION", reasons: ["CURRENCY_MISMATCH"] });
    expect(await attemptOf(r.purchaseId)).toMatchObject({ state: "EXCEPTION", exception_reason: "CURRENCY_MISMATCH" });
  });

  it("an authorization that is not in the CREATED status is a financial exception", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    fake.inject("/authorize", {
      type: "status",
      status: 201,
      body: { id: out.orderId, status: "COMPLETED", purchase_units: [{ payments: { authorizations: [{ id: "AUTH-PENDING", status: "PENDING", amount: { currency_code: "USD", value: "1080.00" } }] } }] },
    });
    expect(await completeApproval(db, deps(), r.who, out.orderId, ctx)).toMatchObject({ ok: false, code: "FINANCIAL_EXCEPTION", reasons: ["STATUS_NOT_AS_EXPECTED"] });
    expect((await attemptOf(r.purchaseId)).state).toBe("EXCEPTION");
  });

  it("an order PayPal says is already authorized (a lost earlier answer) is treated as uncertain, not as a refusal", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    fake.inject("/authorize", { type: "status", status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "x", details: [{ issue: "ORDER_ALREADY_AUTHORIZED" }] } });
    expect(await completeApproval(db, deps(), r.who, out.orderId, ctx)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect((await attemptOf(r.purchaseId)).state).toBe("OUTCOME_UNKNOWN");
  });
});

describe("evidence stays clean", () => {
  it("stored payment events carry only allowlisted keys and no payer details or raw bodies", async () => {
    const r = await ready();
    const out = await checkedOut(r);
    await completeApproval(db, deps(), r.who, out.orderId, ctx);
    const attempt = await attemptOf(r.purchaseId);
    for (const e of await eventsOf(attempt.id)) {
      for (const key of Object.keys(e.payload)) expect(["order_id", "authorization_id", "amount_minor", "currency", "status", "request_id", "outcome"]).toContain(key);
      expect(JSON.stringify(e.payload)).not.toMatch(/payer|email|address|links|href|secret|token/i);
    }
  });

  it("verifiedFor is used only to build customers for these tests", async () => {
    const r = await ready();
    expect(await verifiedFor(db, r.inquiryId)).toBe(r.inquiryId);
  });
});
