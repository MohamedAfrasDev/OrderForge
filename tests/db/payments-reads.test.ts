// Real local Postgres and the LOCAL FAKE PayPal (mocked evidence).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPayPalClient } from "@/lib/paypal/client";
import { completeApproval, startCheckout } from "@/services/payments/checkout";
import { decide } from "@/services/payments/decide";
import { HONOR_PERIOD_DAYS, isPurchasePaid, listDecisionsForMerchant, paymentStatusForCustomer, purchaseIdForCustomer } from "@/services/payments/read";
import type { PayPalPort } from "@/services/payments/shared";
import type { MerchantActor } from "@/services/quote/shared";
import { startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { acceptedPurchase, freshMerchant, type AcceptedPurchase, type Merchant } from "./accepted-purchase";
import { must, serviceClient } from "./helpers";
import { T0 } from "./payments-helpers";
import { expectStockConsistentAtEnd } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

let fake: FakePayPal;
let paypal: PayPalPort;
const ctx = { now: T0, correlationId: "corr-payments-t9" };
const RETURN = "http://localhost:3100/o/TOKEN/return";
const SLOT = { code: "PRODUCTION_SLOT_CONFIRMATION", text: "Production slot to be confirmed." };

beforeAll(async () => {
  fake = await startFakePayPal();
  paypal = createPayPalClient({ env: "sandbox", clientId: "test-client", clientSecret: "test-secret-0000000000", baseUrl: fake.url, timeoutMs: 400 });
});
afterAll(async () => {
  await fake.close();
});

const deps = () => ({ paypal, evidence: "mocked" as const });
type Ready = AcceptedPurchase & { m: Merchant; actor: MerchantActor; orderId: string };

async function checkedOut(conditions: unknown[] = [], m?: Merchant, boxCount?: number): Promise<Ready> {
  const merchant = m ?? (await freshMerchant(db));
  const p = await acceptedPurchase(db, merchant, { conditions, ...(boxCount ? { boxCount } : {}) });
  const started = await startCheckout(db, deps(), p.who, p.purchaseId, { returnUrl: RETURN }, ctx);
  if (!started.ok) throw new Error(`startCheckout: ${started.code}`);
  const orderId = must(await db.from("payment_attempts").select("paypal_order_id").eq("purchase_id", p.purchaseId).single()).paypal_order_id as string;
  return { ...p, m: merchant, actor: { kind: "merchant", userId: randomUUID(), merchantId: merchant.merchantId }, orderId };
}
async function authorized(conditions: unknown[] = [], m?: Merchant, boxCount?: number): Promise<Ready> {
  const r = await checkedOut(conditions, m, boxCount);
  fake.approve(r.orderId);
  const done = await completeApproval(db, deps(), r.who, r.orderId, ctx);
  if (!done.ok) throw new Error(`completeApproval: ${done.code}`);
  return r;
}

describe("paymentStatusForCustomer", () => {
  it("walks through the plain statuses with nothing internal in them", async () => {
    const m = await freshMerchant(db);
    const p = await acceptedPurchase(db, m);
    expect(await paymentStatusForCustomer(db, p.who)).toEqual({ status: "NONE", canPay: true });

    await startCheckout(db, deps(), p.who, p.purchaseId, { returnUrl: RETURN }, ctx);
    expect(await paymentStatusForCustomer(db, p.who)).toEqual({ status: "PAYING", canPay: true });

    const orderId = must(await db.from("payment_attempts").select("paypal_order_id").eq("purchase_id", p.purchaseId).single()).paypal_order_id as string;
    fake.approve(orderId);
    await completeApproval(db, deps(), p.who, orderId, ctx);
    expect(await paymentStatusForCustomer(db, p.who)).toEqual({ status: "WAITING_MERCHANT", canPay: false });

    const actor: MerchantActor = { kind: "merchant", userId: randomUUID(), merchantId: m.merchantId };
    await decide(db, deps(), actor, p.purchaseId, "accepted", {}, ctx);
    expect(await paymentStatusForCustomer(db, p.who)).toEqual({ status: "PAID", canPay: false });
    expect(await isPurchasePaid(db, p.purchaseId)).toBe(true);
  });

  it("a declined order reads as declined and cannot be paid again", async () => {
    const r = await authorized();
    await decide(db, deps(), r.actor, r.purchaseId, "declined", { reason: "No capacity." }, ctx);
    expect(await paymentStatusForCustomer(db, r.who)).toEqual({ status: "DECLINED", canPay: false });
    expect(await isPurchasePaid(db, r.purchaseId)).toBe(false);
  });

  it("a failed attempt can be paid again; a payment in doubt reads as checking", async () => {
    const m = await freshMerchant(db);
    const p = await acceptedPurchase(db, m);
    fake.inject("POST /v2/checkout/orders", { type: "status", status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "no", details: [{ issue: "INVALID_REQUEST" }] } });
    await startCheckout(db, deps(), p.who, p.purchaseId, { returnUrl: RETURN }, ctx);
    expect(await paymentStatusForCustomer(db, p.who)).toEqual({ status: "FAILED", canPay: true });

    const r = await authorized();
    fake.inject("/capture", { type: "drop-after" });
    await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    expect(await paymentStatusForCustomer(db, r.who)).toEqual({ status: "CHECKING", canPay: false });
    expect(await isPurchasePaid(db, r.purchaseId)).toBe(false);
  });

  it("is null without an accepted quote, and purchaseIdForCustomer is the customer's own purchase only", async () => {
    const m = await freshMerchant(db);
    const p = await acceptedPurchase(db, m);
    const other = await acceptedPurchase(db, m);
    expect(await purchaseIdForCustomer(db, p.who)).toBe(p.purchaseId);
    expect(await purchaseIdForCustomer(db, other.who)).toBe(other.purchaseId);
    must(await db.from("quote_versions").update({ status: "SUPERSEDED" }).eq("id", p.quoteId));
    expect(await paymentStatusForCustomer(db, p.who)).toBeNull();
    expect(await purchaseIdForCustomer(db, p.who)).toBeNull();
  });
});

describe("listDecisionsForMerchant", () => {
  it("lists an authorized order waiting for a decision, with the conditions to confirm", async () => {
    const m = await freshMerchant(db);
    const r = await authorized([SLOT], m);
    const rows = await listDecisionsForMerchant(db, m.merchantId, T0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purchaseId: r.purchaseId,
      section: "waiting",
      state: "AUTHORIZED",
      decision: "pending",
      totalMinor: 108000,
      honorWarning: false,
      conditions: [{ code: "PRODUCTION_SLOT_CONFIRMATION", needsConfirmation: true }],
    });
  });

  it("shows the honor-period warning after 3 days", async () => {
    const m = await freshMerchant(db);
    await authorized([], m);
    const late = new Date(Date.parse(T0) + HONOR_PERIOD_DAYS * 86_400_000 + 1000).toISOString();
    expect((await listDecisionsForMerchant(db, m.merchantId, late))[0]!.honorWarning).toBe(true);
  });

  it("puts exceptions first, then waiting, then orders being checked, and drops finished ones", async () => {
    const m = await freshMerchant(db);
    const waiting = await authorized([], m, 10);
    const checking = await authorized([], m, 10);
    fake.inject("/capture", { type: "drop-after" });
    await decide(db, deps(), checking.actor, checking.purchaseId, "accepted", {}, ctx);
    const exception = await authorized([], m, 10);
    fake.inject("/capture", { type: "status", status: 201, body: { id: "CAP-BAD", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } } });
    await decide(db, deps(), exception.actor, exception.purchaseId, "accepted", {}, ctx);
    const done = await authorized([], m, 10);
    await decide(db, deps(), done.actor, done.purchaseId, "accepted", {}, ctx);

    const rows = await listDecisionsForMerchant(db, m.merchantId, T0);
    expect(rows.map((x) => [x.purchaseId, x.section])).toEqual([
      [exception.purchaseId, "exception"],
      [waiting.purchaseId, "waiting"],
      [checking.purchaseId, "checking"],
    ]);
    expect(rows[0]).toMatchObject({ exceptionReason: expect.any(String) });
  });

  it("never shows another merchant's payments", async () => {
    const a = await freshMerchant(db);
    const b = await freshMerchant(db);
    await authorized([], a);
    expect(await listDecisionsForMerchant(db, b.merchantId, T0)).toEqual([]);
  });
});
