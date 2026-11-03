import { describe, expect, it } from "vitest";
import { anonClient, serviceClient } from "./helpers";
import { createJob, paidFixture, payFixture, worksheetFor } from "./fulfillment-helpers";
import { expectStockConsistentAtEnd } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

type Row = { purchase_id: string; paid_at: string };
const missing = async (limit = 200): Promise<Row[]> => {
  const out = await db.rpc("fulfillment_paid_purchases_without_job", { p_limit: limit });
  if (out.error) throw new Error(out.error.message);
  return out.data as Row[];
};

describe("fulfillment_paid_purchases_without_job", () => {
  it("lists a paid purchase that has no job, and stops listing it once the job exists (demo step H)", async () => {
    const f = await paidFixture(db);
    expect((await missing()).map((r) => r.purchase_id)).toContain(f.purchaseId);

    await createJob(db, f.purchaseId, worksheetFor(f));
    expect((await missing()).map((r) => r.purchase_id)).not.toContain(f.purchaseId);
  });

  it("never lists a purchase that is not paid", async () => {
    const unpaid = await payFixture(db, "AUTHORIZED");
    const created = await payFixture(db, "CREATED");
    const ids = (await missing()).map((r) => r.purchase_id);
    expect(ids).not.toContain(unpaid.purchaseId);
    expect(ids).not.toContain(created.purchaseId);
  });

  it("lists the oldest payment first and respects the limit", async () => {
    const first = await paidFixture(db);
    const second = await paidFixture(db);
    const all = await missing();
    const order = all.map((r) => r.purchase_id);
    expect(order.indexOf(first.purchaseId)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(first.purchaseId)).toBeLessThan(order.indexOf(second.purchaseId));
    expect(all.every((r, i) => i === 0 || Date.parse(all[i - 1]!.paid_at) <= Date.parse(r.paid_at))).toBe(true);
    expect((await missing(1)).length).toBeLessThanOrEqual(1);
  });

  it("refuses a limit outside 1 to 200", async () => {
    for (const bad of [0, -1, 201, null]) {
      const out = await db.rpc("fulfillment_paid_purchases_without_job", { p_limit: bad });
      expect(out.error, `limit ${bad}`).toBeTruthy();
    }
  });

  it("is not callable by the anon role", async () => {
    const denied = await anonClient().rpc("fulfillment_paid_purchases_without_job", { p_limit: 10 });
    expect(denied.error?.code).toBe("42501");
  });
});
