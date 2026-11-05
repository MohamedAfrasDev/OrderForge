// The merchant's accept action asks for the job once the money is taken. These tests replace the collaborators and check the
// order of events, who is named, and that a failure to make the job never fails the accept (the reconcile run is the safety net).
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const state = {
  signedIn: true,
  decide: { ok: true, value: { decision: "accepted", state: "CAPTURED" } } as unknown,
  jobThrows: false,
  jobResult: { ok: true, value: { jobId: "job-1", status: "QUEUED", already: false } } as unknown,
};

vi.mock("@/lib/notifications/run", () => ({ notifySoon: vi.fn() }));
vi.mock("next/cache", () => ({ refresh: vi.fn(() => void calls.push("refresh")) }));
vi.mock("@/lib/access/require-merchant", () => ({
  requireMerchant: vi.fn(async () => {
    calls.push("requireMerchant");
    if (!state.signedIn) throw new Error("NEXT_REDIRECT");
    return { user: { id: "user-1", email: "m@example.test" }, merchant: { id: "merchant-1", name: "Demo", slug: "demo" } };
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({ admin: true })) }));
vi.mock("@/lib/payments/wiring", () => ({ createPaymentDeps: vi.fn(() => ({ paypal: {}, evidence: "mocked" })) }));
vi.mock("@/services/payments/decide", () => ({
  decide: vi.fn(async () => {
    calls.push("decide");
    return state.decide;
  }),
}));
const createJobForPurchase = vi.fn<(db: unknown, purchaseId: string, ctx: { actor?: string; correlationId: string }) => Promise<unknown>>(async () => {
  calls.push("createJobForPurchase");
  if (state.jobThrows) throw new Error("database down");
  return state.jobResult;
});
vi.mock("@/services/fulfillment/create", () => ({ createJobForPurchase: (db: unknown, id: string, ctx: { actor?: string; correlationId: string }) => createJobForPurchase(db, id, ctx) }));

import { acceptOrderAction, declineOrderAction } from "@/app/merchant/decisions/actions";

const PURCHASE = "5b1f0f0e-6c0b-4f6e-9c58-0f3a3f1d2a11";
const form = (fields: Record<string, string> = { purchaseId: PURCHASE }) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

beforeEach(() => {
  calls.length = 0;
  createJobForPurchase.mockClear();
  state.signedIn = true;
  state.jobThrows = false;
  state.decide = { ok: true, value: { decision: "accepted", state: "CAPTURED" } };
  state.jobResult = { ok: true, value: { jobId: "job-1", status: "QUEUED", already: false } };
});

describe("acceptOrderAction asks for the job after the capture", () => {
  it("checks the merchant session first, before reading anything", async () => {
    state.signedIn = false;
    await expect(acceptOrderAction({ status: "idle" }, form())).rejects.toThrow("NEXT_REDIRECT");
    expect(calls).toEqual(["requireMerchant"]);
  });

  it("after a capture, asks for the job as the merchant, then refreshes", async () => {
    const result = await acceptOrderAction({ status: "idle" }, form());
    expect(result.status).toBe("done");
    expect(calls).toEqual(["requireMerchant", "decide", "createJobForPurchase", "refresh"]);
    expect(createJobForPurchase).toHaveBeenCalledWith({ admin: true }, PURCHASE, expect.objectContaining({ actor: "merchant:user-1" }));
  });

  it("a failure to make the job (thrown or refused) never fails the accept", async () => {
    state.jobThrows = true;
    expect((await acceptOrderAction({ status: "idle" }, form())).status).toBe("done");
    state.jobThrows = false;
    state.jobResult = { ok: false, code: "NOT_PAID" };
    expect((await acceptOrderAction({ status: "idle" }, form())).status).toBe("done");
  });

  it("asks for no job when the accept did not capture", async () => {
    state.decide = { ok: false, code: "OUTCOME_UNKNOWN" };
    const result = await acceptOrderAction({ status: "idle" }, form());
    expect(result.status).toBe("error");
    expect(createJobForPurchase).not.toHaveBeenCalled();
  });

  it("asks for no job on a decline", async () => {
    state.decide = { ok: true, value: { decision: "declined", state: "VOIDED" } };
    const result = await declineOrderAction({ status: "idle" }, form({ purchaseId: PURCHASE, reason: "No capacity." }));
    expect(result.status).toBe("done");
    expect(createJobForPurchase).not.toHaveBeenCalled();
  });

  it("asks for no job for a purchase id that is not an id", async () => {
    const result = await acceptOrderAction({ status: "idle" }, form({ purchaseId: "not-an-id" }));
    expect(result.status).toBe("error");
    expect(createJobForPurchase).not.toHaveBeenCalled();
  });
});
