// Real local Postgres; purchases are made through the LOCAL FAKE PayPal (mocked evidence). The shop's Today counts, read under the shop's own session.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobForPurchase } from "@/services/fulfillment/create";
import { moveJob } from "@/services/fulfillment/move";
import { merchantOverview } from "@/services/merchant/overview";
import { startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { anonClient, createMerchantUser, must, serviceClient, signedInClient } from "./helpers";
import { T0 } from "./fulfillment-helpers";
import { takeTo, type Paid } from "./fulfillment-paid";
import { expectStockConsistentAtEnd } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

let fake: FakePayPal;
beforeAll(async () => {
  fake = await startFakePayPal();
});
afterAll(async () => {
  await fake.close();
});

const ctx = { now: T0, correlationId: "corr-merchant-overview" };

async function ownedBy(user: { id: string }, upTo: "authorized" | "captured"): Promise<Paid> {
  const p = await takeTo(db, fake, upTo);
  must(await db.from("merchants").update({ owner_user_id: user.id }).eq("id", p.m.merchantId));
  return p;
}

async function shop() {
  const user = await createMerchantUser(db);
  return { user, session: await signedInClient(user.email, user.password) };
}

describe("merchantOverview, under the shop's own session", () => {
  it("counts nothing for a shop with nothing waiting", async () => {
    const { user, session } = await shop();
    const p = await ownedBy(user, "authorized");
    // The shop's one payment is waiting; clear it from the picture by asking about a different, empty shop instead.
    const empty = await shop();
    const other = await takeTo(db, fake, "accepted");
    must(await db.from("merchants").update({ owner_user_id: empty.user.id }).eq("id", other.m.merchantId));
    expect(await merchantOverview(empty.session, other.m.merchantId)).toEqual({ requestsToAnswer: 0, paymentsToDecide: 0, ordersToPrepare: 0 });
    expect((await merchantOverview(session, p.m.merchantId)).paymentsToDecide).toBe(1);
  });

  it("counts the requests that wait for the shop: only inquiries held for review", async () => {
    const { user, session } = await shop();
    const p = await ownedBy(user, "authorized");
    const make = async (status: string) => must(await db.from("inquiries").insert({ merchant_id: p.m.merchantId, status }).select("id").single()).id;
    await make("REVIEW_REQUIRED");
    await make("REVIEW_REQUIRED");
    await make("CLARIFYING");
    await make("QUOTE_READY");
    const view = await merchantOverview(session, p.m.merchantId);
    expect(view.requestsToAnswer).toBe(2);
  });

  it("counts payments that wait for the shop's OK, and orders that are not collected yet", async () => {
    const { user, session } = await shop();
    const waiting = await ownedBy(user, "authorized");
    expect(await merchantOverview(session, waiting.m.merchantId)).toEqual({ requestsToAnswer: 0, paymentsToDecide: 1, ordersToPrepare: 0 });

    const paid = await takeTo(db, fake, "captured");
    must(await db.from("merchants").update({ owner_user_id: user.id }).eq("id", paid.m.merchantId));
    const made = await createJobForPurchase(db, paid.purchaseId, ctx);
    if (!made.ok) throw new Error(`createJob: ${made.code}`);
    expect((await merchantOverview(session, paid.m.merchantId)).ordersToPrepare).toBe(1);

    await moveJob(db, paid.actor, made.value.jobId, "PREPARING", {}, ctx);
    await moveJob(db, paid.actor, made.value.jobId, "READY_FOR_PICKUP", {}, ctx);
    expect((await merchantOverview(session, paid.m.merchantId)).ordersToPrepare).toBe(1); // ready, still not collected
    await moveJob(db, paid.actor, made.value.jobId, "COLLECTED", {}, ctx);
    expect((await merchantOverview(session, paid.m.merchantId)).ordersToPrepare).toBe(0);
  });

  it("never counts another shop's work, and a visitor with no session is refused", async () => {
    const alice = await shop();
    const bob = await shop();
    const mine = await ownedBy(alice.user, "authorized");
    const theirs = await ownedBy(bob.user, "authorized");
    const insert = await db.from("inquiries").insert({ merchant_id: theirs.m.merchantId, status: "REVIEW_REQUIRED" });
    must(insert as never);

    expect(await merchantOverview(alice.session, mine.m.merchantId)).toEqual({ requestsToAnswer: 0, paymentsToDecide: 1, ordersToPrepare: 0 });
    expect(await merchantOverview(alice.session, theirs.m.merchantId)).toEqual({ requestsToAnswer: 0, paymentsToDecide: 0, ordersToPrepare: 0 });
    await expect(merchantOverview(anonClient(), theirs.m.merchantId)).rejects.toThrow(/permission denied/);
  });
});
