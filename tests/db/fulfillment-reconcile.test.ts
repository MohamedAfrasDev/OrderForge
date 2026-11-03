// Real local Postgres; purchases are paid through the LOCAL FAKE PayPal (mocked evidence).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobForPurchase, createMissingJobs } from "@/services/fulfillment/create";
import { reconcileAttempt } from "@/services/payments/reconcile";
import { decide } from "@/services/payments/decide";
import { startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { must, serviceClient } from "./helpers";
import { T0, eventsOf, jobOf } from "./fulfillment-helpers";
import { paypalFor, takeTo } from "./fulfillment-paid";
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

const ctx = { now: T0, correlationId: "corr-fulfillment-t5" };

describe("jobs missed by the accept action are found by the reconcile run (demo step H)", () => {
  it("a capture whose answer was lost, settled later by payments reconciliation, gets its job from the next run, once", async () => {
    const p = await takeTo(db, fake, "authorized");
    const deps = { paypal: paypalFor(fake), evidence: "mocked" as const };
    fake.inject("/capture", { type: "drop-after" });
    expect(await decide(db, deps, p.actor, p.purchaseId, "accepted", {}, ctx)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    // Nobody asked for a job: the accept action never saw a capture.
    expect(await jobOf(db, p.purchaseId)).toBeNull();
    expect(await createMissingJobs(db, ctx, { purchaseIds: [p.purchaseId] })).toMatchObject({ checked: 0, created: 0 });

    const attemptId = must(await db.from("payment_attempts").select("id").eq("purchase_id", p.purchaseId).single()).id as string;
    expect(await reconcileAttempt(db, deps, attemptId, ctx)).toMatchObject({ ok: true, value: { state: "CAPTURED" } });

    expect(await createMissingJobs(db, ctx, { purchaseIds: [p.purchaseId] })).toEqual({ checked: 1, created: 1 });
    expect(await jobOf(db, p.purchaseId)).not.toBeNull();
    expect(await createMissingJobs(db, ctx, { purchaseIds: [p.purchaseId] })).toEqual({ checked: 0, created: 0 });
  });
});

describe("a repeated accept and a reconcile run give one job (demo step B)", () => {
  it("the accept action's call, a second one and the run, all at once", async () => {
    const p = await takeTo(db, fake, "captured");
    const results = await Promise.all([
      createJobForPurchase(db, p.purchaseId, { ...ctx, actor: `merchant:${p.actor.userId}` }),
      createJobForPurchase(db, p.purchaseId, { ...ctx, actor: `merchant:${p.actor.userId}` }),
      createMissingJobs(db, ctx, { purchaseIds: [p.purchaseId] }).catch(() => ({ checked: -1, created: -1 })),
      createJobForPurchase(db, p.purchaseId, ctx),
    ]);
    expect(results.slice(0, 2).every((r) => "ok" in r && r.ok)).toBe(true);
    const jobs = await db.from("preparation_jobs").select("id").eq("purchase_id", p.purchaseId);
    expect(jobs.data).toHaveLength(1);
    const jobId = jobs.data![0]!.id as string;
    expect(await eventsOf(db, jobId)).toHaveLength(1);
    const audits = await db.from("audit_events").select("id").eq("entity", "preparation_job").eq("entity_id", jobId).eq("action", "fulfillment.job_created");
    expect(audits.data).toHaveLength(1);
  });
});
