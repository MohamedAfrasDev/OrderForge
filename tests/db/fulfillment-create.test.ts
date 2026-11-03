import { describe, expect, it } from "vitest";
import { anonClient, serviceClient, unique } from "./helpers";
import { expectStockConsistentAtEnd } from "./reservation-helpers";
import { T0, createJob, decide, eventsOf, jobOf, paidFixture, payFixture, settle, unknownFixture, worksheetFor } from "./fulfillment-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

describe("fulfillment_create_job: a paid purchase gets one job", () => {
  it("creates a QUEUED job with the worksheet and one first event (demo step A)", async () => {
    const f = await paidFixture(db);
    const worksheet = worksheetFor(f);
    const out = await createJob(db, f.purchaseId, worksheet);
    expect(out).toMatchObject({ ok: true, already: false, status: "QUEUED" });

    const job = await jobOf(db, f.purchaseId);
    expect(job).toMatchObject({ id: out.job_id, status: "QUEUED" });
    expect(job!.worksheet).toEqual(JSON.parse(JSON.stringify(worksheet)));
    expect(new Date(job!.created_at).toISOString()).toBe(T0);

    const events = await eventsOf(db, job!.id);
    expect(events).toEqual([{ status: "QUEUED", from_status: null, actor: "system", note: null, created_at: expect.any(String) }]);
  });

  it("asking again returns the same job and adds nothing", async () => {
    const f = await paidFixture(db);
    const first = await createJob(db, f.purchaseId, worksheetFor(f));
    const again = await createJob(db, f.purchaseId, worksheetFor(f), "2026-11-04T10:00:00.000Z");
    expect(again).toMatchObject({ ok: true, already: true, job_id: first.job_id, status: "QUEUED" });
    expect((await eventsOf(db, first.job_id as string))).toHaveLength(1);
    // The first worksheet stands: a later request cannot replace it.
    expect((await jobOf(db, f.purchaseId))!.worksheet.readyBy).toBe("2026-11-10");
  });

  it("ten parallel creations give one job and one first event (demo step B)", async () => {
    const f = await paidFixture(db);
    const results = await Promise.all(Array.from({ length: 10 }, () => createJob(db, f.purchaseId, worksheetFor(f))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.already === false)).toHaveLength(1);
    expect(new Set(results.map((r) => r.job_id)).size).toBe(1);
    const jobs = await db.from("preparation_jobs").select("id").eq("purchase_id", f.purchaseId);
    expect(jobs.data).toHaveLength(1);
    expect(await eventsOf(db, results[0]!.job_id as string)).toHaveLength(1);
  });
});

describe("fulfillment_create_job: no job without a verified capture (demo step C)", () => {
  const refused = async (purchaseId: string, f: Parameters<typeof worksheetFor>[0]) => {
    const out = await createJob(db, purchaseId, worksheetFor(f));
    expect(out).toMatchObject({ ok: false, code: "NOT_PAID" });
    expect(await jobOf(db, purchaseId)).toBeNull();
  };

  it("a purchase with no payment attempt", async () => {
    const f = await payFixture(db, "CREATED");
    await refused(f.purchaseId, f);
  });

  it("a checkout in progress (order created, approved)", async () => {
    for (const state of ["PROVIDER_CREATED", "APPROVED"] as const) {
      const f = await payFixture(db, state);
      await refused(f.purchaseId, f);
    }
  });

  it("an authorization waiting for the merchant", async () => {
    const f = await payFixture(db, "AUTHORIZED");
    await refused(f.purchaseId, f);
  });

  it("an accepted decision whose capture is still in flight", async () => {
    const f = await payFixture(db, "AUTHORIZED");
    expect((await decide(db, f, "accepted")).ok).toBe(true);
    expect((await f.attempt()).state).toBe("CAPTURE_IN_FLIGHT");
    await refused(f.purchaseId, f);
  });

  it("a declined and voided order", async () => {
    const f = await payFixture(db, "AUTHORIZED");
    expect((await decide(db, f, "declined", { reason: "Cannot make it." })).ok).toBe(true);
    expect((await settle(db, f.attemptId, "VOIDED")).ok).toBe(true);
    await refused(f.purchaseId, f);
  });

  it("a capture whose outcome is unknown", async () => {
    const f = await unknownFixture(db, "capture");
    await refused(f.purchaseId, f);
  });

  it("a capture that was a financial exception", async () => {
    const f = await payFixture(db, "AUTHORIZED");
    expect((await decide(db, f, "accepted")).ok).toBe(true);
    expect((await settle(db, f.attemptId, "EXCEPTION", { p_exception_reason: "AMOUNT_MISMATCH", p_capture_id: unique("CAP-BAD") })).ok).toBe(true);
    await refused(f.purchaseId, f);
  });

  it("an unknown purchase is NOT_FOUND", async () => {
    const f = await paidFixture(db);
    const ghost = "00000000-0000-4000-8000-00000000dead";
    expect(await createJob(db, ghost, worksheetFor(f, { purchaseId: ghost }))).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("fulfillment_create_job: the worksheet is checked", () => {
  it("rejects a worksheet that is not for this purchase, has the wrong tag, is not an object or is too large", async () => {
    const f = await paidFixture(db);
    const other = await paidFixture(db);
    for (const bad of [
      worksheetFor(other),
      { ...worksheetFor(f), schema: "orderforge.worksheet.v0" },
      [worksheetFor(f)],
      "text",
      null,
      { ...worksheetFor(f), note: "x".repeat(30_000) },
    ]) {
      expect(await createJob(db, f.purchaseId, bad)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(await createJob(db, f.purchaseId, worksheetFor(f), null as never)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await jobOf(db, f.purchaseId)).toBeNull();
  });
});

describe("fulfillment_create_job: who may call it", () => {
  it("is not callable by the anon role", async () => {
    const f = await paidFixture(db);
    const denied = await anonClient().rpc("fulfillment_create_job", { p_purchase_id: f.purchaseId, p_worksheet: worksheetFor(f), p_now: T0 });
    expect(denied.error?.code).toBe("42501");
    expect(await jobOf(db, f.purchaseId)).toBeNull();
  });
});
