// Real local Postgres; purchases are paid through the LOCAL FAKE PayPal (mocked evidence).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobForPurchase } from "@/services/fulfillment/create";
import { moveJob } from "@/services/fulfillment/move";
import { jobStatusForCustomer, listJobsForMerchant, readJob } from "@/services/fulfillment/read";
import { startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { createMerchantUser, must, serviceClient, signedInClient } from "./helpers";
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

const ctx = { now: T0, correlationId: "corr-fulfillment-reads" };

async function withJob(p?: Paid): Promise<{ p: Paid; jobId: string }> {
  const paid = p ?? (await takeTo(db, fake, "captured"));
  const made = await createJobForPurchase(db, paid.purchaseId, ctx);
  if (!made.ok) throw new Error(`createJob: ${made.code}`);
  return { p: paid, jobId: made.value.jobId };
}

describe("jobStatusForCustomer", () => {
  it("is null before there is a job, and for an inquiry with no accepted quote", async () => {
    const p = await takeTo(db, fake, "captured");
    expect(await jobStatusForCustomer(db, p.who)).toBeNull();
    const accepted = await takeTo(db, fake, "accepted");
    expect(await jobStatusForCustomer(db, accepted.who)).toBeNull();
  });

  it("shows the plain status and the ready-by day, and nothing else (demo step G)", async () => {
    const { p, jobId } = await withJob();
    const view = await jobStatusForCustomer(db, p.who);
    expect(view).toEqual({ status: "PREPARING", readyBy: "2026-11-10" });
    expect(Object.keys(view!).sort()).toEqual(["readyBy", "status"]);

    await moveJob(db, p.actor, jobId, "PREPARING", {}, ctx);
    await moveJob(db, p.actor, jobId, "READY_FOR_PICKUP", {}, ctx);
    expect((await jobStatusForCustomer(db, p.who))!.status).toBe("READY");
    await moveJob(db, p.actor, jobId, "COLLECTED", {}, ctx);
    expect((await jobStatusForCustomer(db, p.who))!.status).toBe("COLLECTED");
  });

  it("a hold reads as delayed and never shows the merchant's note", async () => {
    const { p, jobId } = await withJob();
    await moveJob(db, p.actor, jobId, "ON_HOLD", { note: "Supplier lost the ribbon, internal." }, ctx);
    const view = await jobStatusForCustomer(db, p.who);
    expect(view).toEqual({ status: "DELAYED", readyBy: "2026-11-10" });
    expect(JSON.stringify(view)).not.toMatch(/ribbon|internal/i);
  });

  it("each customer sees only their own job", async () => {
    const mine = await withJob();
    const theirs = await withJob();
    await moveJob(db, theirs.p.actor, theirs.jobId, "PREPARING", {}, ctx);
    await moveJob(db, theirs.p.actor, theirs.jobId, "READY_FOR_PICKUP", {}, ctx);
    expect((await jobStatusForCustomer(db, mine.p.who))!.status).toBe("PREPARING");
    expect((await jobStatusForCustomer(db, theirs.p.who))!.status).toBe("READY");
  });
});

describe("the merchant's reads, under their own session", () => {
  async function ownedBy(user: { id: string }, upTo: "captured" = "captured"): Promise<Paid> {
    const p = await takeTo(db, fake, upTo);
    must(await db.from("merchants").update({ owner_user_id: user.id }).eq("id", p.m.merchantId));
    return p;
  }

  it("lists their jobs newest first with the worksheet and the events, and reads one in full", async () => {
    const user = await createMerchantUser(db);
    const session = await signedInClient(user.email, user.password);
    const p = await ownedBy(user);
    const first = await withJob(p);
    await moveJob(db, p.actor, first.jobId, "PREPARING", { note: "Started." }, { ...ctx, now: "2026-11-03T11:00:00.000Z" });

    const jobs = await listJobsForMerchant(session, p.m.merchantId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ jobId: first.jobId, purchaseId: p.purchaseId, status: "PREPARING", readyBy: "2026-11-10" });
    expect(jobs[0]!.worksheet.pick).toHaveLength(5);
    expect(jobs[0]!.events.map((e) => [e.fromStatus, e.status, e.note])).toEqual([
      [null, "QUEUED", null],
      ["QUEUED", "PREPARING", "Started."],
    ]);

    const one = await readJob(session, p.m.merchantId, first.jobId);
    expect(one).toEqual(jobs[0]);
  });

  it("never shows another merchant's jobs, even when their id is asked for", async () => {
    const alice = await createMerchantUser(db);
    const bob = await createMerchantUser(db);
    const aliceSession = await signedInClient(alice.email, alice.password);
    const mine = await withJob(await ownedBy(alice));
    const theirs = await withJob(await ownedBy(bob));

    expect((await listJobsForMerchant(aliceSession, mine.p.m.merchantId)).map((j) => j.jobId)).toEqual([mine.jobId]);
    expect(await listJobsForMerchant(aliceSession, theirs.p.m.merchantId)).toEqual([]);
    expect(await readJob(aliceSession, theirs.p.m.merchantId, theirs.jobId)).toBeNull();
    expect(await readJob(aliceSession, mine.p.m.merchantId, theirs.jobId)).toBeNull();
  });
});
