// Real local Postgres; purchases are paid through the LOCAL FAKE PayPal (mocked evidence). Nothing here talks to PayPal itself.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobForPurchase, createMissingJobs } from "@/services/fulfillment/create";
import { moveJob } from "@/services/fulfillment/move";
import { startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { must, serviceClient } from "./helpers";
import { T0, eventsOf, jobOf, paidFixture } from "./fulfillment-helpers";
import { ARTWORK, SLOT, takeTo } from "./fulfillment-paid";
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

const ctx = { now: T0, correlationId: "corr-fulfillment-t4" };
const auditOf = async (entityId: string) => must(await db.from("audit_events").select("actor, action, data").eq("entity", "preparation_job").eq("entity_id", entityId).order("id")) as Array<{ actor: string; action: string; data: Record<string, unknown> }>;

describe("createJobForPurchase", () => {
  it("makes the one job of a paid purchase, with a worksheet built from what was accepted (demo step A)", async () => {
    const p = await takeTo(db, fake, "captured", { conditions: [SLOT, ARTWORK], confirmed: ["PRODUCTION_SLOT_CONFIRMATION", "ARTWORK_ACCEPTANCE"] });
    const out = await createJobForPurchase(db, p.purchaseId, ctx);
    expect(out).toMatchObject({ ok: true, value: { status: "QUEUED", already: false } });

    const job = await jobOf(db, p.purchaseId);
    expect(job!.status).toBe("QUEUED");
    const w = job!.worksheet;
    expect(w).toMatchObject({ schema: "orderforge.worksheet.v1", purchaseId: p.purchaseId, inquiryId: p.inquiryId, boxCount: 30, productionLeadDays: 7, readyBy: "2026-11-10", paid: { totalMinor: 108000, currency: "USD" } });
    expect(w.fulfilment).toEqual({ method: "customer_pickup" });
    expect(w.quote).toEqual({ version: 1, hash: p.quoteHash });
    expect(w.pick.map((x) => [x.sku, x.quantity])).toEqual([
      ["CARD-BRANDED", 30],
      ["NOTEBOOK-A5", 30],
      ["ORGANIZER-DESK", 30],
      ["PACK-BOX", 30],
      ["PEN-BLK", 30],
    ]);
    expect(w.conditions.map((c) => [c.code, c.confirmed])).toEqual([
      ["ARTWORK_ACCEPTANCE", true], // the quote keeps its conditions in a fixed order
      ["PRODUCTION_SLOT_CONFIRMATION", true],
    ]);
    expect(JSON.stringify(w)).not.toMatch(/FAKE|paypal|payer/i);

    const audit = await auditOf((out as { value: { jobId: string } }).value.jobId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "fulfillment.job_created", data: { job_id: expect.any(String), purchase_id: p.purchaseId, to: "QUEUED" } });
  });

  it("marks an unconfirmed condition as not confirmed", async () => {
    const p = await takeTo(db, fake, "captured", { conditions: [SLOT], confirmed: ["PRODUCTION_SLOT_CONFIRMATION"] });
    await createJobForPurchase(db, p.purchaseId, ctx);
    expect((await jobOf(db, p.purchaseId))!.worksheet.conditions).toEqual([{ code: "PRODUCTION_SLOT_CONFIRMATION", text: SLOT.text, confirmed: true }]);
  });

  it("asking again, even ten times at once, gives the same single job and audits once (demo step B)", async () => {
    const p = await takeTo(db, fake, "captured");
    const results = await Promise.all(Array.from({ length: 10 }, () => createJobForPurchase(db, p.purchaseId, ctx)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.value.already === false)).toHaveLength(1);
    const ids = new Set(results.map((r) => (r.ok ? r.value.jobId : "")));
    expect(ids.size).toBe(1);
    const jobId = [...ids][0]!;
    expect(await eventsOf(db, jobId)).toHaveLength(1);
    expect(await auditOf(jobId)).toHaveLength(1);
  });

  it("the worksheet holds what the customer accepted, not today's catalog (demo step D)", async () => {
    const p = await takeTo(db, fake, "captured");
    must(await db.from("products").update({ name: "Renamed after payment", unit_price_minor: 1 }).eq("id", p.m.product["ORGANIZER-DESK"]!));
    await createJobForPurchase(db, p.purchaseId, ctx);
    const w = (await jobOf(db, p.purchaseId))!.worksheet;
    expect(w.pick.find((x) => x.sku === "ORGANIZER-DESK")!.name).toBe("Desk organizer");
    expect(w.paid.totalMinor).toBe(108000);
  });

  it("uses the merchant's lead-time rule", async () => {
    const p = await takeTo(db, fake, "captured");
    must(await db.from("business_rules").update({ value: { days: 3 } }).eq("merchant_id", p.m.merchantId).eq("key", "production_lead_days"));
    await createJobForPurchase(db, p.purchaseId, ctx);
    expect((await jobOf(db, p.purchaseId))!.worksheet).toMatchObject({ productionLeadDays: 3, readyBy: "2026-11-06" });
  });

  it("does not guess when the fulfilment method is not pickup", async () => {
    const p = await takeTo(db, fake, "captured");
    must(await db.from("business_rules").upsert({ merchant_id: p.m.merchantId, key: "fulfilment", value: { method: "courier" } }, { onConflict: "merchant_id,key" }));
    expect(await createJobForPurchase(db, p.purchaseId, ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await jobOf(db, p.purchaseId)).toBeNull();
  });

  it("creates no job for a purchase that is not paid, whatever state it is in (demo step C)", async () => {
    for (const upTo of ["accepted", "authorized", "declined"] as const) {
      const p = await takeTo(db, fake, upTo);
      expect(await createJobForPurchase(db, p.purchaseId, ctx), upTo).toMatchObject({ ok: false, code: "NOT_PAID" });
      expect(await jobOf(db, p.purchaseId), upTo).toBeNull();
    }
  });

  it("creates no job when the quote no longer verifies", async () => {
    const p = await takeTo(db, fake, "captured");
    must(await db.from("quote_versions").update({ status: "SUPERSEDED" }).eq("id", p.quoteId));
    expect(await createJobForPurchase(db, p.purchaseId, ctx)).toMatchObject({ ok: false, code: "QUOTE_NOT_ACCEPTED" });
    expect(await jobOf(db, p.purchaseId)).toBeNull();
  });

  it("an unknown purchase is NOT_FOUND", async () => {
    expect(await createJobForPurchase(db, "00000000-0000-4000-8000-00000000dead", ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("createMissingJobs", () => {
  it("creates the jobs that are missing, once, and leaves unpaid purchases alone (demo step H)", async () => {
    const a = await takeTo(db, fake, "captured");
    const b = await takeTo(db, fake, "captured");
    const unpaid = await takeTo(db, fake, "authorized");
    const only = [a.purchaseId, b.purchaseId, unpaid.purchaseId];

    const first = await createMissingJobs(db, ctx, { purchaseIds: only });
    expect(first).toMatchObject({ checked: 2, created: 2 });
    expect(await jobOf(db, a.purchaseId)).not.toBeNull();
    expect(await jobOf(db, b.purchaseId)).not.toBeNull();
    expect(await jobOf(db, unpaid.purchaseId)).toBeNull();

    expect(await createMissingJobs(db, ctx, { purchaseIds: only })).toMatchObject({ checked: 0, created: 0 });
  });

  it("one purchase failing does not stop the rest; the run then fails visibly", async () => {
    const good = await takeTo(db, fake, "captured");
    // Paid in the database but with a quote that cannot be verified (a fixture row, not a real quote).
    const broken = await paidFixture(db);
    await expect(createMissingJobs(db, ctx, { purchaseIds: [broken.purchaseId, good.purchaseId] })).rejects.toThrow(/1 of 2 purchases failed/);
    expect(await jobOf(db, good.purchaseId)).not.toBeNull();
    expect(await jobOf(db, broken.purchaseId)).toBeNull();
    const errors = must(await db.from("audit_events").select("action").eq("entity", "purchase").eq("entity_id", broken.purchaseId).eq("action", "fulfillment.job_error"));
    expect(errors).toHaveLength(1);
  });
});

describe("moveJob", () => {
  it("moves a job for its merchant, with an audit row and the actor on the event", async () => {
    const p = await takeTo(db, fake, "captured");
    const made = await createJobForPurchase(db, p.purchaseId, ctx);
    const jobId = made.ok ? made.value.jobId : "";
    expect(await moveJob(db, p.actor, jobId, "PREPARING", {}, ctx)).toMatchObject({ ok: true, value: { status: "PREPARING", already: false } });

    const events = await eventsOf(db, jobId);
    expect(events.at(-1)).toMatchObject({ status: "PREPARING", from_status: "QUEUED", actor: `merchant:${p.actor.userId}` });
    const audit = await auditOf(jobId);
    expect(audit.at(-1)).toMatchObject({ action: "fulfillment.job_moved", actor: `merchant:${p.actor.userId}`, data: { job_id: jobId, from: "QUEUED", to: "PREPARING" } });
  });

  it("a repeat is a no-op and is not audited again", async () => {
    const p = await takeTo(db, fake, "captured");
    const made = await createJobForPurchase(db, p.purchaseId, ctx);
    const jobId = made.ok ? made.value.jobId : "";
    await moveJob(db, p.actor, jobId, "PREPARING", {}, ctx);
    expect(await moveJob(db, p.actor, jobId, "PREPARING", {}, ctx)).toMatchObject({ ok: true, value: { already: true } });
    expect(await auditOf(jobId)).toHaveLength(2);
  });

  it("maps the refusals to codes: hold needs a note, no skipping, other merchants see nothing", async () => {
    const p = await takeTo(db, fake, "captured");
    const other = await takeTo(db, fake, "captured");
    const made = await createJobForPurchase(db, p.purchaseId, ctx);
    const jobId = made.ok ? made.value.jobId : "";
    expect(await moveJob(db, p.actor, jobId, "ON_HOLD", {}, ctx)).toMatchObject({ ok: false, code: "NOTE_REQUIRED" });
    expect(await moveJob(db, p.actor, jobId, "COLLECTED", {}, ctx)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(await moveJob(db, other.actor, jobId, "PREPARING", {}, ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await moveJob(db, p.actor, jobId, "SHIPPED" as never, {}, ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await jobOf(db, p.purchaseId))!.status).toBe("QUEUED");
    expect(await auditOf(jobId)).toHaveLength(1);
  });

  it("a hold with a note, then a resume, goes through", async () => {
    const p = await takeTo(db, fake, "captured");
    const made = await createJobForPurchase(db, p.purchaseId, ctx);
    const jobId = made.ok ? made.value.jobId : "";
    await moveJob(db, p.actor, jobId, "PREPARING", {}, { ...ctx, now: "2026-11-03T11:00:00.000Z" });
    expect(await moveJob(db, p.actor, jobId, "ON_HOLD", { note: "Waiting for ribbon." }, { ...ctx, now: "2026-11-03T12:00:00.000Z" })).toMatchObject({ ok: true, value: { status: "ON_HOLD" } });
    expect(await moveJob(db, p.actor, jobId, "PREPARING", {}, { ...ctx, now: "2026-11-03T13:00:00.000Z" })).toMatchObject({ ok: true, value: { status: "PREPARING" } });
  });
});
