import { describe, expect, it } from "vitest";
import {
  attemptEvidence,
  codeOf,
  createChain,
  must,
  randomHash,
  serviceClient,
  SQLSTATE,
  unique,
} from "./helpers";

const db = serviceClient();

// Evidence label for this file: real Postgres (local Supabase), not mocked.

describe("payment attempts", () => {
  it("rejects a duplicate PayPal order id", async () => {
    const orderId = unique("ORDER");
    const other = await createChain(db);
    must(await db.from("payment_attempts").insert({
      purchase_id: other.purchaseId, amount_minor: 100, quote_hash: other.quoteHash, paypal_order_id: orderId,
    }));
    const third = await createChain(db);
    const dup = await db.from("payment_attempts").insert({
      purchase_id: third.purchaseId, amount_minor: 100, quote_hash: third.quoteHash, paypal_order_id: orderId,
    });
    expect(codeOf(dup)).toBe(SQLSTATE.unique);
  });

  it.each(["authorization_id", "capture_id"] as const)("rejects a duplicate %s", async (column) => {
    const value = unique(column);
    // An authorization id travels with its time (migration 0007), so the row is otherwise consistent.
    const extra = column === "authorization_id" ? { authorized_at: "2026-11-03T10:00:00Z" } : {};
    const a = await createChain(db);
    const b = await createChain(db);
    must(await db.from("payment_attempts").insert({
      purchase_id: a.purchaseId, amount_minor: 100, quote_hash: a.quoteHash, [column]: value, ...extra,
    }));
    const dup = await db.from("payment_attempts").insert({
      purchase_id: b.purchaseId, amount_minor: 100, quote_hash: b.quoteHash, [column]: value, ...extra,
    });
    expect(codeOf(dup)).toBe(SQLSTATE.unique);
  });

  it("rejects a second active attempt for the same purchase", async () => {
    const own = await createChain(db);
    must(await db.from("payment_attempts").insert({ purchase_id: own.purchaseId, amount_minor: 100, quote_hash: own.quoteHash }));
    const second = await db.from("payment_attempts").insert({ purchase_id: own.purchaseId, amount_minor: 100, quote_hash: own.quoteHash });
    expect(codeOf(second)).toBe(SQLSTATE.unique);
  });

  it.each(["VOIDED", "EXPIRED", "FAILED", "CAPTURED"])(
    "allows a new attempt once the previous one is %s",
    async (terminal) => {
      const own = await createChain(db);
      // The attempt guard (migration 0007) forbids jumping a state, so the earlier attempt is written already finished.
      must(
        await db.from("payment_attempts").insert({ purchase_id: own.purchaseId, amount_minor: 100, quote_hash: own.quoteHash, state: terminal, ...attemptEvidence(terminal) }),
      );
      const next = await db.from("payment_attempts").insert({ purchase_id: own.purchaseId, amount_minor: 100, quote_hash: own.quoteHash });
      expect(codeOf(next)).toBe("none");
    },
  );

  it("blocks a new attempt while the previous one is OUTCOME_UNKNOWN", async () => {
    const own = await createChain(db);
    must(
      await db.from("payment_attempts").insert({
        purchase_id: own.purchaseId, amount_minor: 100, quote_hash: own.quoteHash, state: "OUTCOME_UNKNOWN", unknown_operation: "capture", ...attemptEvidence("AUTHORIZED"),
      }),
    );
    const next = await db.from("payment_attempts").insert({ purchase_id: own.purchaseId, amount_minor: 100, quote_hash: own.quoteHash });
    expect(codeOf(next)).toBe(SQLSTATE.unique);
  });

  it("requires unknown_operation exactly while OUTCOME_UNKNOWN", async () => {
    const withoutOp = await newAttemptFor("OUTCOME_UNKNOWN", null);
    expect(codeOf(withoutOp)).toBe(SQLSTATE.check);

    const staleOp = await newAttemptFor("AUTHORIZED", "capture");
    expect(codeOf(staleOp)).toBe(SQLSTATE.check);

    const ok = await newAttemptFor("OUTCOME_UNKNOWN", "void");
    expect(codeOf(ok)).toBe("none");
  });

  it("rejects non-positive amounts, non-USD currency and a malformed quote hash", async () => {
    const own = await createChain(db);
    const base = { purchase_id: own.purchaseId, amount_minor: 100, quote_hash: own.quoteHash };
    expect(codeOf(await db.from("payment_attempts").insert({ ...base, amount_minor: 0 }))).toBe(SQLSTATE.check);
    expect(codeOf(await db.from("payment_attempts").insert({ ...base, currency: "EUR" }))).toBe(SQLSTATE.check);
    expect(codeOf(await db.from("payment_attempts").insert({ ...base, quote_hash: "not-a-hash" }))).toBe(SQLSTATE.check);
  });

  async function newAttemptFor(state: string, op: string | null) {
    const own = await createChain(db);
    return db.from("payment_attempts").insert({
      purchase_id: own.purchaseId, amount_minor: 100, quote_hash: own.quoteHash, state, unknown_operation: op,
    });
  }
});

describe("payment events", () => {
  it("rejects a duplicate provider event id (webhook dedupe)", async () => {
    const eventId = unique("WH");
    const row = { provider_event_id: eventId, event_type: "PAYMENT.CAPTURE.COMPLETED", source: "webhook", evidence_label: "mocked" };
    expect(codeOf(await db.from("payment_events").insert(row))).toBe("none");
    expect(codeOf(await db.from("payment_events").insert(row))).toBe(SQLSTATE.unique);
  });

  it("allows many events without a provider event id", async () => {
    const row = { event_type: "local", source: "api", evidence_label: "mocked" };
    expect(codeOf(await db.from("payment_events").insert(row))).toBe("none");
    expect(codeOf(await db.from("payment_events").insert(row))).toBe("none");
  });

  it("requires a known source and evidence label", async () => {
    const base = { event_type: "x", source: "api", evidence_label: "mocked" };
    expect(codeOf(await db.from("payment_events").insert({ ...base, source: "browser" }))).toBe(SQLSTATE.check);
    expect(codeOf(await db.from("payment_events").insert({ ...base, evidence_label: "trust-me" }))).toBe(SQLSTATE.check);
  });
});

describe("preparation jobs", () => {
  it("rejects a second job for the same purchase", async () => {
    const own = await createChain(db);
    expect(codeOf(await db.from("preparation_jobs").insert({ purchase_id: own.purchaseId, worksheet: {} }))).toBe("none");
    expect(codeOf(await db.from("preparation_jobs").insert({ purchase_id: own.purchaseId, worksheet: {} }))).toBe(SQLSTATE.unique);
  });
});

describe("quote versions", () => {
  it("blocks edits to a published quote but allows a status change", async () => {
    const own = await createChain(db);
    const edit = await db.from("quote_versions").update({ total_minor: 1 }).eq("id", own.quoteId);
    expect(codeOf(edit)).toBe(SQLSTATE.raised);
    const lines = await db.from("quote_versions").update({ lines: [{ sku: "x" }] }).eq("id", own.quoteId);
    expect(codeOf(lines)).toBe(SQLSTATE.raised);
    const hash = await db.from("quote_versions").update({ quote_hash: randomHash() }).eq("id", own.quoteId);
    expect(codeOf(hash)).toBe(SQLSTATE.raised);

    expect(codeOf(await db.from("quote_versions").update({ status: "ACCEPTED" }).eq("id", own.quoteId))).toBe("none");
  });

  it.each(["SUPERSEDED", "EXPIRED", "WITHDRAWN"])("treats %s as terminal", async (terminal) => {
    const own = await createChain(db);
    must(await db.from("quote_versions").update({ status: terminal }).eq("id", own.quoteId));
    const back = await db.from("quote_versions").update({ status: "PUBLISHED" }).eq("id", own.quoteId);
    expect(codeOf(back)).toBe(SQLSTATE.raised);
  });

  it("cannot return to DRAFT and cannot delete a non-draft row", async () => {
    const own = await createChain(db);
    expect(codeOf(await db.from("quote_versions").update({ status: "DRAFT" }).eq("id", own.quoteId))).toBe(SQLSTATE.raised);
    expect(codeOf(await db.from("quote_versions").delete().eq("id", own.quoteId))).toBe(SQLSTATE.raised);
  });

  it("lets a DRAFT be edited freely, and requires a hash once it leaves DRAFT", async () => {
    const own = await createChain(db);
    // Migration 0005 allows one live quote per inquiry, so retire version 1 before publishing version 2.
    must(await db.from("quote_versions").update({ status: "SUPERSEDED" }).eq("id", own.quoteId));
    const draft = must(
      await db.from("quote_versions").insert({ inquiry_id: own.inquiryId, version: 2, lines: [], total_minor: 5 }).select("id").single(),
    );
    expect(codeOf(await db.from("quote_versions").update({ total_minor: 6 }).eq("id", draft.id))).toBe("none");
    expect(codeOf(await db.from("quote_versions").update({ status: "PUBLISHED" }).eq("id", draft.id))).toBe(SQLSTATE.check);
    expect(
      codeOf(await db.from("quote_versions").update({ status: "PUBLISHED", quote_hash: randomHash() }).eq("id", draft.id)),
    ).toBe("none");
  });
});

describe("approvals", () => {
  it("are append-only", async () => {
    const own = await createChain(db);
    expect(codeOf(await db.from("approvals").update({ terms_text: "changed" }).eq("id", own.approvalId))).toBe(SQLSTATE.raised);
    expect(codeOf(await db.from("approvals").delete().eq("id", own.approvalId))).toBe(SQLSTATE.raised);
  });

  it("allows only one approval per quote version", async () => {
    const own = await createChain(db);
    const again = await db.from("approvals").insert({ quote_version_id: own.quoteId, quote_hash: own.quoteHash, terms_text: "again" });
    expect(codeOf(again)).toBe(SQLSTATE.unique);
  });
});

describe("merchant decisions", () => {
  async function pendingDecision() {
    const own = await createChain(db);
    must(await db.from("merchant_decisions").insert({
      purchase_id: own.purchaseId, quote_version_id: own.quoteId, merchant_id: own.merchantId,
    }));
    return own;
  }

  it("allows one decision record per purchase", async () => {
    const own = await pendingDecision();
    const dup = await db.from("merchant_decisions").insert({
      purchase_id: own.purchaseId, quote_version_id: own.quoteId, merchant_id: own.merchantId,
    });
    expect(codeOf(dup)).toBe(SQLSTATE.unique);
  });

  it("requires a reason to decline", async () => {
    const own = await pendingDecision();
    const bare = await db.from("merchant_decisions").update({ decision: "declined", decided_at: new Date().toISOString() }).eq("purchase_id", own.purchaseId);
    expect(codeOf(bare)).toBe(SQLSTATE.check);
  });

  it("makes a recorded decision final, so confirm and decline cannot both win", async () => {
    const own = await pendingDecision();
    const now = new Date().toISOString();
    expect(codeOf(await db.from("merchant_decisions").update({ decision: "accepted", decided_at: now }).eq("purchase_id", own.purchaseId))).toBe("none");
    const flip = await db.from("merchant_decisions").update({ decision: "declined", reason: "changed my mind", decided_at: now }).eq("purchase_id", own.purchaseId);
    expect(codeOf(flip)).toBe(SQLSTATE.raised);
    expect(codeOf(await db.from("merchant_decisions").delete().eq("purchase_id", own.purchaseId))).toBe(SQLSTATE.raised);
  });

  it("keeps decision and decided_at consistent", async () => {
    const own = await pendingDecision();
    const stamped = await db.from("merchant_decisions").update({ decided_at: new Date().toISOString() }).eq("purchase_id", own.purchaseId);
    expect(codeOf(stamped)).toBe(SQLSTATE.check);
  });
});

describe("stock and money columns", () => {
  async function product() {
    const own = await createChain(db);
    return must(
      await db.from("products").insert({
        merchant_id: own.merchantId, sku: unique("SKU"), name: "p", category: "c", unit_price_minor: 100,
      }).select("id").single(),
    );
  }

  it("never lets reserved exceed on_hand", async () => {
    const p = await product();
    expect(codeOf(await db.from("stock").insert({ product_id: p.id, on_hand: 5, reserved: 6 }))).toBe(SQLSTATE.check);
    expect(codeOf(await db.from("stock").insert({ product_id: p.id, on_hand: 5, reserved: 5 }))).toBe("none");
    expect(codeOf(await db.from("stock").update({ reserved: 6 }).eq("product_id", p.id))).toBe(SQLSTATE.check);
  });

  it("rejects negative prices and non-USD currency", async () => {
    const own = await createChain(db);
    const base = { merchant_id: own.merchantId, sku: unique("SKU"), name: "p", category: "c", unit_price_minor: 100 };
    expect(codeOf(await db.from("products").insert({ ...base, unit_price_minor: -1 }))).toBe(SQLSTATE.check);
    expect(codeOf(await db.from("products").insert({ ...base, sku: unique("SKU"), currency: "EUR" }))).toBe(SQLSTATE.check);
  });

  it("rejects unknown inquiry and reservation states", async () => {
    const own = await createChain(db);
    expect(codeOf(await db.from("inquiries").insert({ merchant_id: own.merchantId, status: "BOGUS" }))).toBe(SQLSTATE.check);
    expect(codeOf(await db.from("reservations").insert({ purchase_id: own.purchaseId, state: "BOGUS" }))).toBe(SQLSTATE.check);
  });
});
