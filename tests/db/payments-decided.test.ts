// Real local Postgres and the LOCAL FAKE PayPal (mocked evidence). The merchant's "recently decided" list shows a decision as finished only
// when PayPal's result confirms it: the money taken (accepted) or the hold released (declined). Read-only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPayPalClient } from "@/lib/paypal/client";
import { completeApproval, startCheckout } from "@/services/payments/checkout";
import { decide } from "@/services/payments/decide";
import { listRecentlyDecided } from "@/services/payments/read";
import type { PayPalPort } from "@/services/payments/shared";
import type { MerchantActor } from "@/services/quote/shared";
import { startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { acceptedPurchase, freshMerchant, type Merchant } from "./accepted-purchase";
import { must, serviceClient } from "./helpers";
import { T0 } from "./payments-helpers";
import { expectStockConsistentAtEnd } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

let fake: FakePayPal;
let paypal: PayPalPort;
const ctx = { now: T0, correlationId: "corr-decided" };
const RETURN = "http://localhost:3100/o/TOKEN/return";

beforeAll(async () => {
  fake = await startFakePayPal();
  paypal = createPayPalClient({ env: "sandbox", clientId: "test-client", clientSecret: "test-secret-0000000000", baseUrl: fake.url, timeoutMs: 400 });
});
afterAll(async () => {
  await fake.close();
});

const deps = () => ({ paypal, evidence: "mocked" as const });

async function authorized(m: Merchant, boxCount?: number) {
  const p = await acceptedPurchase(db, m, boxCount ? { boxCount } : {});
  const started = await startCheckout(db, deps(), p.who, p.purchaseId, { returnUrl: RETURN }, ctx);
  if (!started.ok) throw new Error(`startCheckout: ${started.code}`);
  const orderId = must(await db.from("payment_attempts").select("paypal_order_id").eq("purchase_id", p.purchaseId).single()).paypal_order_id as string;
  fake.approve(orderId);
  const done = await completeApproval(db, deps(), p.who, orderId, ctx);
  if (!done.ok) throw new Error(`completeApproval: ${done.code}`);
  const actor: MerchantActor = { kind: "merchant", userId: randomUUID(), merchantId: m.merchantId };
  return { ...p, actor };
}

describe("listRecentlyDecided", () => {
  it("is empty for a shop with nothing decided, and an order waiting for a decision is not listed", async () => {
    const m = await freshMerchant(db);
    expect(await listRecentlyDecided(db, m.merchantId)).toEqual([]);
    await authorized(m);
    expect(await listRecentlyDecided(db, m.merchantId)).toEqual([]);
  });

  it("lists an accepted order as charged and a declined one as released, newest first, with the exact total", async () => {
    const m = await freshMerchant(db);
    const accepted = await authorized(m);
    const declined = await authorized(m);
    await decide(db, deps(), accepted.actor, accepted.purchaseId, "accepted", {}, ctx);
    await decide(db, deps(), declined.actor, declined.purchaseId, "declined", { reason: "No capacity." }, ctx);

    const rows = await listRecentlyDecided(db, m.merchantId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.purchaseId === accepted.purchaseId)).toMatchObject({ decision: "accepted", outcome: "charged", totalMinor: 108000 });
    expect(rows.find((r) => r.purchaseId === declined.purchaseId)).toMatchObject({ decision: "declined", outcome: "released", totalMinor: 108000 });
    expect(Date.parse(rows[0]!.decidedAt)).toBeGreaterThanOrEqual(Date.parse(rows[1]!.decidedAt));
  });

  it("does not call a decision finished while PayPal's answer is in doubt", async () => {
    const m = await freshMerchant(db);
    const r = await authorized(m);
    fake.inject("/capture", { type: "drop-after" });
    await decide(db, deps(), r.actor, r.purchaseId, "accepted", {}, ctx);
    expect(await listRecentlyDecided(db, m.merchantId)).toEqual([]); // it is under "Being checked", not "decided"
  });

  it("shows only the asked shop's decisions and no more than the limit", async () => {
    const a = await freshMerchant(db);
    const b = await freshMerchant(db);
    for (let i = 0; i < 3; i++) {
      const r = await authorized(a);
      await decide(db, deps(), r.actor, r.purchaseId, "declined", { reason: "No." }, ctx);
    }
    const theirs = await authorized(b);
    await decide(db, deps(), theirs.actor, theirs.purchaseId, "declined", { reason: "No." }, ctx);

    expect(await listRecentlyDecided(db, a.merchantId, 2)).toHaveLength(2);
    expect(await listRecentlyDecided(db, a.merchantId)).toHaveLength(3);
    expect((await listRecentlyDecided(db, a.merchantId)).some((r) => r.purchaseId === theirs.purchaseId)).toBe(false);
  });
});
