import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { JOB_STATUSES, type JobStatus } from "@/domain/fulfillment";
import { SQLSTATE, serviceClient } from "./helpers";
import { createJob, eventsOf, jobOf, paidFixture, worksheetFor } from "./fulfillment-helpers";
import { expectStockConsistentAtEnd } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

// Written separately from the migration: what the database trigger must allow. ON_HOLD may go back to any of the three
// holdable statuses here; fulfillment_move_job (T3) narrows a resume to the status the job left.
const TRIGGER_TABLE: Record<JobStatus, JobStatus[]> = {
  QUEUED: ["PREPARING", "ON_HOLD"],
  PREPARING: ["READY_FOR_PICKUP", "ON_HOLD"],
  READY_FOR_PICKUP: ["COLLECTED", "ON_HOLD"],
  COLLECTED: [],
  ON_HOLD: ["QUEUED", "PREPARING", "READY_FOR_PICKUP"],
};

const setStatus = (client: SupabaseClient, jobId: string, status: string) => client.from("preparation_jobs").update({ status }).eq("id", jobId);

/** A fresh paid purchase's job, walked along the legal path to `status`. */
async function jobAt(status: JobStatus): Promise<{ jobId: string; purchaseId: string }> {
  const f = await paidFixture(db);
  const made = await createJob(db, f.purchaseId, worksheetFor(f));
  const jobId = made.job_id as string;
  const path: Record<JobStatus, string[]> = {
    QUEUED: [],
    PREPARING: ["PREPARING"],
    READY_FOR_PICKUP: ["PREPARING", "READY_FOR_PICKUP"],
    COLLECTED: ["PREPARING", "READY_FOR_PICKUP", "COLLECTED"],
    ON_HOLD: ["ON_HOLD"],
  };
  for (const step of path[status]) {
    const moved = await setStatus(db, jobId, step);
    if (moved.error) throw new Error(`walk to ${status}: ${moved.error.message}`);
  }
  return { jobId, purchaseId: f.purchaseId };
}

describe("the job status trigger", () => {
  for (const from of JOB_STATUSES) {
    it(`from ${from}: every status outside the table is rejected and leaves the job as it was`, async () => {
      const { jobId, purchaseId } = await jobAt(from);
      for (const to of JOB_STATUSES) {
        if (to === from || TRIGGER_TABLE[from].includes(to)) continue;
        const result = await setStatus(db, jobId, to);
        expect(result.error, `${from} -> ${to}`).toBeTruthy();
        expect((await jobOf(db, purchaseId))!.status).toBe(from);
      }
    });

    for (const to of TRIGGER_TABLE[from]) {
      it(`${from} -> ${to} is allowed`, async () => {
        const { jobId, purchaseId } = await jobAt(from);
        const result = await setStatus(db, jobId, to);
        expect(result.error).toBeNull();
        expect((await jobOf(db, purchaseId))!.status).toBe(to);
      });
    }
  }

  it("rejects an unknown status", async () => {
    const { jobId, purchaseId } = await jobAt("QUEUED");
    const result = await setStatus(db, jobId, "SHIPPED");
    expect(result.error).toBeTruthy(); // the trigger or the check constraint, whichever fires first
    expect((await jobOf(db, purchaseId))!.status).toBe("QUEUED");
  });
});

describe("what never changes", () => {
  it("the worksheet and the purchase are fixed from creation (demo step D)", async () => {
    const f = await paidFixture(db);
    const other = await paidFixture(db);
    const made = await createJob(db, f.purchaseId, worksheetFor(f));
    const jobId = made.job_id as string;

    const worksheet = await db.from("preparation_jobs").update({ worksheet: { ...worksheetFor(f), readyBy: "2030-01-01" } }).eq("id", jobId);
    expect(worksheet.error).toBeTruthy();
    const purchase = await db.from("preparation_jobs").update({ purchase_id: other.purchaseId }).eq("id", jobId);
    expect(purchase.error).toBeTruthy();
    expect((await jobOf(db, f.purchaseId))!.worksheet.readyBy).toBe("2026-11-10");
  });

  it("a COLLECTED job cannot change at all", async () => {
    const { jobId, purchaseId } = await jobAt("COLLECTED");
    for (const to of JOB_STATUSES) {
      if (to === "COLLECTED") continue;
      expect((await setStatus(db, jobId, to)).error, `COLLECTED -> ${to}`).toBeTruthy();
    }
    expect((await jobOf(db, purchaseId))!.status).toBe("COLLECTED");
  });

  it("a second job for one purchase is rejected by the unique constraint", async () => {
    const f = await paidFixture(db);
    await createJob(db, f.purchaseId, worksheetFor(f));
    const second = await db.from("preparation_jobs").insert({ purchase_id: f.purchaseId, worksheet: worksheetFor(f) });
    expect(second.error?.code).toBe(SQLSTATE.unique);
  });
});

describe("the event log", () => {
  it("rejects updates and deletes of an event", async () => {
    const { jobId } = await jobAt("QUEUED");
    const [event] = await db.from("preparation_events").select("id").eq("job_id", jobId).then((r) => r.data ?? []);
    expect(event).toBeTruthy();
    expect((await db.from("preparation_events").update({ note: "edited" }).eq("id", event!.id)).error).toBeTruthy();
    expect((await db.from("preparation_events").delete().eq("id", event!.id)).error).toBeTruthy();
    expect(await eventsOf(db, jobId)).toHaveLength(1);
  });

  it("checks the new columns", async () => {
    const { jobId } = await jobAt("QUEUED");
    const bad = await db.from("preparation_events").insert({ job_id: jobId, status: "PREPARING", from_status: "SHIPPED", actor: "merchant:x" });
    expect(bad.error?.code).toBe(SQLSTATE.check);
    const empty = await db.from("preparation_events").insert({ job_id: jobId, status: "PREPARING", from_status: "QUEUED", actor: "" });
    expect(empty.error?.code).toBe(SQLSTATE.check);
    const ok = await db.from("preparation_events").insert({ job_id: jobId, status: "PREPARING", from_status: "QUEUED", actor: "merchant:x", note: "started" });
    expect(ok.error).toBeNull();
  });
});
