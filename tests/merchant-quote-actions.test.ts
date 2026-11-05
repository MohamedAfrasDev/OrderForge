// The merchant quote actions are public endpoints and now also release holds for quotes they replace.
// These tests replace the collaborators and check the order of events and that a failed release never fails the publish.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const state = { signedIn: true, publish: { ok: true, value: { invalidatedPurchaseIds: [] as string[] } } as unknown, releaseThrows: false };

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
vi.mock("@/services/quote/publish", () => ({
  publishQuote: vi.fn(async () => {
    calls.push("publishQuote");
    return state.publish;
  }),
  withdrawQuote: vi.fn(async () => ({ ok: true, value: undefined })),
}));
const releaseForInvalidatedPurchases = vi.fn<(db: unknown, ids: string[], ctx: { actor?: string; correlationId: string }) => Promise<unknown>>(async () => {
  calls.push("releaseForInvalidatedPurchases");
  if (state.releaseThrows) throw new Error("database down");
  return { ok: true, value: { released: 1, flagged: 0, skipped: 0 } };
});
vi.mock("@/services/reservation/release", () => ({ releaseForInvalidatedPurchases: (db: unknown, ids: string[], ctx: { actor?: string; correlationId: string }) => releaseForInvalidatedPurchases(db, ids, ctx) }));

import { publishDraftAction } from "@/app/merchant/quotes/actions";

const QUOTE = "5b1f0f0e-6c0b-4f6e-9c58-0f3a3f1d2a11";
const form = (fields: Record<string, string> = { quoteId: QUOTE, wording: "ok" }) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

beforeEach(() => {
  calls.length = 0;
  releaseForInvalidatedPurchases.mockClear();
  state.signedIn = true;
  state.releaseThrows = false;
  state.publish = { ok: true, value: { invalidatedPurchaseIds: [] } };
});

describe("publishDraftAction releases holds for the quote it replaces", () => {
  it("checks the merchant session first, before reading anything or publishing", async () => {
    state.signedIn = false;
    await expect(publishDraftAction({ status: "idle" }, form())).rejects.toThrow("NEXT_REDIRECT");
    expect(calls).toEqual(["requireMerchant"]);
    expect(releaseForInvalidatedPurchases).not.toHaveBeenCalled();
  });

  it("after a publish that invalidated purchases, releases their holds as the merchant, then refreshes", async () => {
    state.publish = { ok: true, value: { invalidatedPurchaseIds: ["p-1", "p-2"] } };
    const result = await publishDraftAction({ status: "idle" }, form());
    expect(result.status).toBe("done");
    expect(calls).toEqual(["requireMerchant", "publishQuote", "releaseForInvalidatedPurchases", "refresh"]);
    const [, ids, ctx] = releaseForInvalidatedPurchases.mock.calls[0]!;
    expect(ids).toEqual(["p-1", "p-2"]);
    expect(ctx).toMatchObject({ actor: "merchant:user-1" });
    expect(ctx.correlationId).toBeTruthy();
  });

  it("does nothing about holds when the publish replaced no accepted quote", async () => {
    const result = await publishDraftAction({ status: "idle" }, form());
    expect(result.status).toBe("done");
    expect(releaseForInvalidatedPurchases).not.toHaveBeenCalled();
  });

  it("does not touch holds when the publish was refused", async () => {
    state.publish = { ok: false, code: "PAYMENT_STARTED" };
    const result = await publishDraftAction({ status: "idle" }, form());
    expect(result).toMatchObject({ status: "error" });
    expect(releaseForInvalidatedPurchases).not.toHaveBeenCalled();
  });

  it("a failing release never fails the publish: the scheduled sweep picks the holds up", async () => {
    state.publish = { ok: true, value: { invalidatedPurchaseIds: ["p-1"] } };
    state.releaseThrows = true;
    const result = await publishDraftAction({ status: "idle" }, form());
    expect(result.status).toBe("done");
    expect(calls).toContain("refresh");
  });

  it("a malformed quote id publishes nothing", async () => {
    const result = await publishDraftAction({ status: "idle" }, form({ quoteId: "not-a-uuid", wording: "x" }));
    expect(result).toMatchObject({ status: "error" });
    expect(calls).toEqual(["requireMerchant"]);
  });
});
