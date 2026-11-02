// The dev page's server actions are public endpoints, so each must verify the merchant session
// BEFORE doing anything else. These tests replace the collaborators and check that ordering.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

vi.mock("@/lib/access/require-merchant", () => ({
  requireMerchant: vi.fn(async () => {
    calls.push("requireMerchant");
    if (state.signedIn) return { user: { id: "user-1", email: "m@example.test" }, merchant: { id: "m1", name: "Demo", slug: "demo" } };
    // Next's redirect() throws; this stands in for it.
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("@/lib/paypal/spike-wiring", () => ({
  createSpikeDeps: vi.fn(() => {
    calls.push("createSpikeDeps");
    return {};
  }),
  spikeTarget: vi.fn(() => {
    calls.push("spikeTarget");
    return { isFake: false, evidence: "real-sandbox", baseUrl: undefined };
  }),
}));

vi.mock("@/lib/paypal/spike", () => ({
  createSpikeOrder: vi.fn(async () => {
    calls.push("createSpikeOrder");
    return { orderId: "ORDER1", approveUrl: undefined, steps: [] };
  }),
  finishSpike: vi.fn(async () => {
    calls.push("finishSpike");
    return { steps: [], ok: true };
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    calls.push("createAdminClient");
    return {};
  }),
}));

vi.mock("@/lib/paypal/spike-store", () => ({
  spikeStore: vi.fn(() => ({
    insertAudit: async () => void calls.push("insertAudit"),
    recordEvent: async () => void calls.push("recordEvent"),
  })),
}));

const state = { signedIn: true };

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

async function actions() {
  return import("@/app/merchant/dev/paypal/actions");
}

beforeEach(() => {
  calls.length = 0;
  state.signedIn = true;
});

describe("spikeAction", () => {
  it.each(["create", "approve-fake", "capture", "void", "anything-else", ""])(
    "does nothing at all without a merchant session (intent %j)",
    async (intent) => {
      state.signedIn = false;
      const { spikeAction } = await actions();
      await expect(spikeAction(null, form({ intent, orderId: "ORDER1" }))).rejects.toThrow("NEXT_REDIRECT");
      expect(calls).toEqual(["requireMerchant"]);
    },
  );

  it("checks the session before building PayPal or database access", async () => {
    const { spikeAction } = await actions();
    await spikeAction(null, form({ intent: "create" }));
    expect(calls[0]).toBe("requireMerchant");
    expect(calls.indexOf("requireMerchant")).toBeLessThan(calls.indexOf("createSpikeDeps"));
    expect(calls.indexOf("createSpikeDeps")).toBeLessThan(calls.indexOf("createSpikeOrder"));
  });

  it("refuses to capture or void a malformed order id, without calling PayPal", async () => {
    const { spikeAction } = await actions();
    for (const orderId of ["", "../orders", "A B", "x".repeat(65)]) {
      calls.length = 0;
      const result = await spikeAction(null, form({ intent: "capture", orderId }));
      expect(result?.message).toBe("Create an order first.");
      expect(calls).not.toContain("finishSpike");
    }
  });

  it("only simulates a buyer approval against the local fake", async () => {
    const { spikeAction } = await actions();
    const result = await spikeAction(null, form({ intent: "approve-fake", orderId: "ORDER1" }));
    expect(result?.message).toMatch(/only works with the local fake/);
  });
});

describe("reconcileNowAction", () => {
  it("does nothing at all without a merchant session", async () => {
    state.signedIn = false;
    const { reconcileNowAction } = await actions();
    await expect(reconcileNowAction()).rejects.toThrow("NEXT_REDIRECT");
    expect(calls).toEqual(["requireMerchant"]);
  });

  it("records a heartbeat for a signed-in merchant", async () => {
    const { reconcileNowAction } = await actions();
    expect(await reconcileNowAction()).toEqual({ message: "Reconcile heartbeat recorded." });
    expect(calls).toEqual(["requireMerchant", "createAdminClient", "insertAudit"]);
  });
});
