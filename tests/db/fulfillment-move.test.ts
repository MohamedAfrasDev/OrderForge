import { describe, expect, it } from "vitest";
import { anonClient, must, serviceClient } from "./helpers";
import { createJob, eventsOf, jobOf, paidFixture, worksheetFor, type Fixture } from "./fulfillment-helpers";
import { pay } from "./payments-helpers";
import { addMinutes, expectStockConsistentAtEnd } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

const T = "2026-11-03T10:00:00.000Z";
const move = (jobId: string, merchantId: string, to: string, over: { note?: string | null; actor?: string; now?: string } = {}) =>
  pay(db, "fulfillment_move_job", {
    p_job_id: jobId,
    p_merchant_id: merchantId,
    p_to: to,
    p_note: over.note ?? null,
    p_actor: over.actor ?? `merchant:${merchantId.slice(0, 8)}`,
    p_now: over.now ?? T,
  });

async function newJob(): Promise<{ f: Fixture; jobId: string }> {
  const f = await paidFixture(db);
  const made = await createJob(db, f.purchaseId, worksheetFor(f));
  return { f, jobId: made.job_id as string };
}
const statusOf = async (f: Fixture) => (await jobOf(db, f.purchaseId))!.status;

describe("moving a job along (demo step E)", () => {
  it("QUEUED to PREPARING to READY_FOR_PICKUP to COLLECTED, one event each with who and from where", async () => {
    const { f, jobId } = await newJob();
    expect(await move(jobId, f.merchantId, "PREPARING", { now: addMinutes(T, 1), actor: "merchant:alice" })).toMatchObject({ ok: true, already: false, status: "PREPARING", from: "QUEUED" });
    expect(await move(jobId, f.merchantId, "READY_FOR_PICKUP", { now: addMinutes(T, 2), note: "Boxed and labeled." })).toMatchObject({ ok: true, status: "READY_FOR_PICKUP" });
    expect(await move(jobId, f.merchantId, "COLLECTED", { now: addMinutes(T, 3) })).toMatchObject({ ok: true, status: "COLLECTED" });

    const events = await eventsOf(db, jobId);
    expect(events.map((e) => [e.from_status, e.status])).toEqual([
      [null, "QUEUED"],
      ["QUEUED", "PREPARING"],
      ["PREPARING", "READY_FOR_PICKUP"],
      ["READY_FOR_PICKUP", "COLLECTED"],
    ]);
    expect(events[1]!.actor).toBe("merchant:alice");
    expect(events[2]!.note).toBe("Boxed and labeled.");
    expect(await statusOf(f)).toBe("COLLECTED");
  });

  it("refuses to skip a step or go backwards, adding no event", async () => {
    const { f, jobId } = await newJob();
    for (const to of ["READY_FOR_PICKUP", "COLLECTED"]) expect(await move(jobId, f.merchantId, to)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    await move(jobId, f.merchantId, "PREPARING");
    await move(jobId, f.merchantId, "READY_FOR_PICKUP");
    for (const to of ["QUEUED", "PREPARING"]) expect(await move(jobId, f.merchantId, to)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(await statusOf(f)).toBe("READY_FOR_PICKUP");
    expect(await eventsOf(db, jobId)).toHaveLength(3);
  });

  it("COLLECTED is final", async () => {
    const { f, jobId } = await newJob();
    for (const to of ["PREPARING", "READY_FOR_PICKUP", "COLLECTED"]) await move(jobId, f.merchantId, to);
    for (const to of ["QUEUED", "PREPARING", "READY_FOR_PICKUP", "ON_HOLD"]) {
      expect(await move(jobId, f.merchantId, to, { note: "x" })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    }
    expect(await statusOf(f)).toBe("COLLECTED");
  });

  it("a double click moves it once (a repeat of the move just made is a no-op)", async () => {
    const { f, jobId } = await newJob();
    expect(await move(jobId, f.merchantId, "PREPARING")).toMatchObject({ ok: true, already: false });
    expect(await move(jobId, f.merchantId, "PREPARING")).toMatchObject({ ok: true, already: true, status: "PREPARING" });
    expect(await eventsOf(db, jobId)).toHaveLength(2);
  });

  it("five simultaneous identical moves move it once", async () => {
    const { f, jobId } = await newJob();
    const results = await Promise.all(Array.from({ length: 5 }, () => move(jobId, f.merchantId, "PREPARING")));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.already === false)).toHaveLength(1);
    expect(await eventsOf(db, jobId)).toHaveLength(2);
    expect(await statusOf(f)).toBe("PREPARING");
  });

  it("two different moves at once leave a consistent log: every event matches one that succeeded", async () => {
    const { f, jobId } = await newJob();
    const results = await Promise.all([move(jobId, f.merchantId, "PREPARING"), move(jobId, f.merchantId, "ON_HOLD", { note: "Out of ribbon." })]);
    const succeeded = results.filter((r) => r.ok && r.already === false).length;
    expect(succeeded).toBeGreaterThanOrEqual(1);
    const events = await eventsOf(db, jobId);
    expect(events).toHaveLength(1 + succeeded);
    expect(events.at(-1)!.status).toBe(await statusOf(f));
  });
});

describe("holding and resuming (demo step F)", () => {
  for (const left of ["QUEUED", "PREPARING", "READY_FOR_PICKUP"] as const) {
    it(`a hold from ${left} resumes to ${left} and nowhere else, with the note on the event`, async () => {
      const { f, jobId } = await newJob();
      if (left !== "QUEUED") await move(jobId, f.merchantId, "PREPARING", { now: addMinutes(T, 1) });
      if (left === "READY_FOR_PICKUP") await move(jobId, f.merchantId, "READY_FOR_PICKUP", { now: addMinutes(T, 2) });

      expect(await move(jobId, f.merchantId, "ON_HOLD", { note: "Waiting for ribbon.", now: addMinutes(T, 5) })).toMatchObject({ ok: true, status: "ON_HOLD", from: left });
      expect(await statusOf(f)).toBe("ON_HOLD");
      for (const wrong of ["QUEUED", "PREPARING", "READY_FOR_PICKUP", "COLLECTED"].filter((s) => s !== left)) {
        expect(await move(jobId, f.merchantId, wrong), `resume to ${wrong}`).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
      }
      expect(await move(jobId, f.merchantId, left, { now: addMinutes(T, 9) })).toMatchObject({ ok: true, status: left, from: "ON_HOLD" });
      expect(await statusOf(f)).toBe(left);

      const events = await eventsOf(db, jobId);
      const hold = events.find((e) => e.status === "ON_HOLD")!;
      expect(hold).toMatchObject({ from_status: left, note: "Waiting for ribbon." });
      expect(events.at(-1)).toMatchObject({ status: left, from_status: "ON_HOLD" });
    });
  }

  it("a second hold after a resume remembers its own starting point", async () => {
    const { f, jobId } = await newJob();
    await move(jobId, f.merchantId, "ON_HOLD", { note: "first", now: addMinutes(T, 1) });
    await move(jobId, f.merchantId, "QUEUED", { now: addMinutes(T, 2) });
    await move(jobId, f.merchantId, "PREPARING", { now: addMinutes(T, 3) });
    await move(jobId, f.merchantId, "ON_HOLD", { note: "second", now: addMinutes(T, 4) });
    expect(await move(jobId, f.merchantId, "QUEUED", { now: addMinutes(T, 5) })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(await move(jobId, f.merchantId, "PREPARING", { now: addMinutes(T, 5) })).toMatchObject({ ok: true, status: "PREPARING" });
  });

  it("a hold needs a note", async () => {
    const { f, jobId } = await newJob();
    for (const note of [null, "", "   "]) {
      expect(await move(jobId, f.merchantId, "ON_HOLD", { note })).toMatchObject({ ok: false, code: "NOTE_REQUIRED" });
    }
    expect(await statusOf(f)).toBe("QUEUED");
    expect(await eventsOf(db, jobId)).toHaveLength(1);
  });

  it("a repeated hold is a no-op", async () => {
    const { f, jobId } = await newJob();
    await move(jobId, f.merchantId, "ON_HOLD", { note: "one" });
    expect(await move(jobId, f.merchantId, "ON_HOLD", { note: "two" })).toMatchObject({ ok: true, already: true });
    expect(await eventsOf(db, jobId)).toHaveLength(2);
  });
});

describe("input and ownership", () => {
  it("rejects an unknown status, an over-long note and a missing actor", async () => {
    const { f, jobId } = await newJob();
    expect(await move(jobId, f.merchantId, "SHIPPED")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await move(jobId, f.merchantId, "PREPARING", { note: "x".repeat(501) })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await move(jobId, f.merchantId, "PREPARING", { actor: "" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await statusOf(f)).toBe("QUEUED");
  });

  it("another merchant's job is NOT_FOUND and nothing changes; so is an unknown job", async () => {
    const { f, jobId } = await newJob();
    const stranger = await paidFixture(db);
    expect(await move(jobId, stranger.merchantId, "PREPARING")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await move("00000000-0000-4000-8000-00000000dead", f.merchantId, "PREPARING")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await statusOf(f)).toBe("QUEUED");
    expect(await eventsOf(db, jobId)).toHaveLength(1);
  });

  it("moves on different jobs do not interfere", async () => {
    const a = await newJob();
    const b = await newJob();
    const results = await Promise.all([move(a.jobId, a.f.merchantId, "PREPARING"), move(b.jobId, b.f.merchantId, "PREPARING")]);
    expect(results.every((r) => r.ok && r.already === false)).toBe(true);
  });

  it("is not callable by the anon role", async () => {
    const { f, jobId } = await newJob();
    const denied = await anonClient().rpc("fulfillment_move_job", { p_job_id: jobId, p_merchant_id: f.merchantId, p_to: "PREPARING", p_note: null, p_actor: "x", p_now: T });
    expect(denied.error?.code).toBe("42501");
    expect(await statusOf(f)).toBe("QUEUED");
    must({ data: true, error: null });
  });
});
