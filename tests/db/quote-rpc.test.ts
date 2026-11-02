import { describe, expect, it } from "vitest";
import { codeOf, must, randomHash, serviceClient, SQLSTATE, anonClient } from "./helpers";
import { accept, newDraft, newInquiry, NOW, publish, rpc, statusOf } from "./quote-helpers";

const db = serviceClient();

// Evidence label for this file: real Postgres (local Supabase), not mocked.

describe("create_quote_draft", () => {
  it("assigns versions 1, 2, 3 in order", async () => {
    const { inquiryId } = await newInquiry(db);
    expect((await newDraft(db, inquiryId)).version).toBe(1);
    expect((await newDraft(db, inquiryId)).version).toBe(2);
    expect((await newDraft(db, inquiryId)).version).toBe(3);
  });

  it("gives five simultaneous drafts five different versions", async () => {
    const { inquiryId } = await newInquiry(db);
    const drafts = await Promise.all(Array.from({ length: 5 }, () => newDraft(db, inquiryId)));
    expect(drafts.map((d) => d.version).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("reports an unknown inquiry as NOT_FOUND", async () => {
    const r = await rpc(db, "create_quote_draft", {
      p_inquiry_id: "00000000-0000-4000-8000-000000000000",
      p_requirement_version_id: null,
      p_lines: {},
      p_total_minor: 1,
      p_pending_conditions: [],
    });
    expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("publish_quote", () => {
  it("publishes a draft: status, hash, timestamp, and the inquiry becomes QUOTE_READY", async () => {
    const { inquiryId } = await newInquiry(db);
    const { quoteId } = await newDraft(db, inquiryId);
    const hash = randomHash();
    const r = await publish(db, quoteId, hash);
    expect(r.ok).toBe(true);
    const row = must(await db.from("quote_versions").select("status, quote_hash, published_at").eq("id", quoteId).single());
    expect(row.status).toBe("PUBLISHED");
    expect(row.quote_hash).toBe(hash);
    expect(new Date(row.published_at as string).toISOString()).toBe(NOW);
    const inquiry = must(await db.from("inquiries").select("status").eq("id", inquiryId).single());
    expect(inquiry.status).toBe("QUOTE_READY");
  });

  it("supersedes the live quote when a newer version is published", async () => {
    const { inquiryId } = await newInquiry(db);
    const v1 = await newDraft(db, inquiryId);
    await publish(db, v1.quoteId);
    const v2 = await newDraft(db, inquiryId);
    const r = await publish(db, v2.quoteId);
    expect(r).toMatchObject({ ok: true, superseded_quote_id: v1.quoteId });
    expect(await statusOf(db, v1.quoteId)).toBe("SUPERSEDED");
    expect(await statusOf(db, v2.quoteId)).toBe("PUBLISHED");
  });

  it("refuses anything that is not a draft", async () => {
    const { inquiryId } = await newInquiry(db);
    const { quoteId } = await newDraft(db, inquiryId);
    await publish(db, quoteId);
    expect(await publish(db, quoteId)).toMatchObject({ ok: false, code: "NOT_DRAFT" });
  });

  it("reports an unknown quote as NOT_FOUND", async () => {
    expect(await publish(db, "00000000-0000-4000-8000-000000000000")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("the partial unique index rejects a second live quote written directly", async () => {
    const { inquiryId } = await newInquiry(db);
    const a = await newDraft(db, inquiryId);
    const b = await newDraft(db, inquiryId);
    await publish(db, a.quoteId);
    const direct = await db
      .from("quote_versions")
      .update({ status: "PUBLISHED", quote_hash: randomHash(), published_at: NOW })
      .eq("id", b.quoteId);
    expect(codeOf(direct)).toBe(SQLSTATE.unique);
  });

  it("publishing a newer version after acceptance supersedes it and reports the invalidated purchase", async () => {
    const { inquiryId } = await newInquiry(db);
    const v1 = await newDraft(db, inquiryId);
    const { hash } = await publish(db, v1.quoteId);
    const accepted = await accept(db, v1.quoteId, hash);
    const v2 = await newDraft(db, inquiryId);
    const r = await publish(db, v2.quoteId);
    expect(r).toMatchObject({ ok: true, superseded_quote_id: v1.quoteId });
    expect(r.invalidated_purchase_ids).toEqual([accepted.purchase_id]);
    expect(await statusOf(db, v1.quoteId)).toBe("SUPERSEDED");
  });
});

describe("PAYMENT_STARTED", () => {
  async function acceptedWithAttempt(state: string) {
    const { inquiryId } = await newInquiry(db);
    const v1 = await newDraft(db, inquiryId);
    const { hash } = await publish(db, v1.quoteId);
    const a = await accept(db, v1.quoteId, hash);
    const attempt = await db.from("payment_attempts").insert({
      purchase_id: a.purchase_id,
      amount_minor: 108000,
      quote_hash: hash,
      state,
      unknown_operation: state === "OUTCOME_UNKNOWN" ? "authorize" : null,
    });
    expect(codeOf(attempt)).toBe("none");
    const v2 = await newDraft(db, inquiryId);
    return { v1, v2 };
  }

  it.each(["PROVIDER_CREATED", "APPROVED", "AUTHORIZED", "CAPTURED", "OUTCOME_UNKNOWN"])(
    "refuses to supersede an accepted quote while an attempt is %s",
    async (state) => {
      const { v1, v2 } = await acceptedWithAttempt(state);
      expect(await publish(db, v2.quoteId)).toMatchObject({ ok: false, code: "PAYMENT_STARTED" });
      expect(await statusOf(db, v1.quoteId)).toBe("ACCEPTED");
      expect(await statusOf(db, v2.quoteId)).toBe("DRAFT");
    },
  );

  it.each(["CREATED", "VOIDED", "EXPIRED", "FAILED"])("allows superseding when the only attempt is %s", async (state) => {
    const { v1, v2 } = await acceptedWithAttempt(state);
    expect((await publish(db, v2.quoteId)).ok).toBe(true);
    expect(await statusOf(db, v1.quoteId)).toBe("SUPERSEDED");
  });
});

describe("accept_quote", () => {
  async function published() {
    const { inquiryId, merchantId } = await newInquiry(db);
    const { quoteId } = await newDraft(db, inquiryId);
    const { hash } = await publish(db, quoteId);
    return { inquiryId, merchantId, quoteId, hash };
  }

  it("creates one approval and one purchase and marks the quote ACCEPTED", async () => {
    const { inquiryId, merchantId, quoteId, hash } = await published();
    const r = await accept(db, quoteId, hash);
    expect(r).toMatchObject({ ok: true, already: false });
    expect(await statusOf(db, quoteId)).toBe("ACCEPTED");
    const approval = must(await db.from("approvals").select("quote_hash, terms_text").eq("id", r.approval_id!).single());
    expect(approval).toEqual({ quote_hash: hash, terms_text: "test terms" });
    const purchase = must(await db.from("purchases").select("merchant_id, inquiry_id, quote_version_id, approval_id").eq("id", r.purchase_id!).single());
    expect(purchase).toEqual({ merchant_id: merchantId, inquiry_id: inquiryId, quote_version_id: quoteId, approval_id: r.approval_id });
  });

  it("is idempotent: a second accept returns the same ids", async () => {
    const { quoteId, hash } = await published();
    const first = await accept(db, quoteId, hash);
    const second = await accept(db, quoteId, hash);
    expect(second).toMatchObject({ ok: true, already: true, approval_id: first.approval_id, purchase_id: first.purchase_id });
  });

  it("refuses a different hash, before and after acceptance", async () => {
    const { quoteId, hash } = await published();
    expect(await accept(db, quoteId, randomHash())).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
    expect(await statusOf(db, quoteId)).toBe("PUBLISHED");
    await accept(db, quoteId, hash);
    expect(await accept(db, quoteId, randomHash())).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
  });

  it("refuses a draft, a superseded and a withdrawn quote with their own codes", async () => {
    const { inquiryId } = await newInquiry(db);
    const draft = await newDraft(db, inquiryId);
    expect(await accept(db, draft.quoteId, randomHash())).toMatchObject({ ok: false, code: "NOT_PUBLISHED" });

    const v1 = await newDraft(db, inquiryId);
    const p1 = await publish(db, v1.quoteId);
    const v2 = await newDraft(db, inquiryId);
    await publish(db, v2.quoteId);
    expect(await accept(db, v1.quoteId, p1.hash)).toMatchObject({ ok: false, code: "SUPERSEDED" });

    must(await db.from("quote_versions").update({ status: "WITHDRAWN" }).eq("id", v2.quoteId));
    expect(await accept(db, v2.quoteId, randomHash())).toMatchObject({ ok: false, code: "WITHDRAWN" });
  });

  it("accepts at exactly published_at + validity and expires one millisecond later", async () => {
    const atBoundary = await published();
    expect((await accept(db, atBoundary.quoteId, atBoundary.hash, "2026-11-06T10:00:00.000Z")).ok).toBe(true);

    const late = await published();
    const r = await accept(db, late.quoteId, late.hash, "2026-11-06T10:00:00.001Z");
    expect(r).toMatchObject({ ok: false, code: "EXPIRED" });
    expect(await statusOf(db, late.quoteId)).toBe("EXPIRED");
  });

  it("reports an unknown quote as NOT_FOUND", async () => {
    expect(await accept(db, "00000000-0000-4000-8000-000000000000", randomHash())).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("five simultaneous accepts yield one approval and one purchase", async () => {
    const { quoteId, hash } = await published();
    const results = await Promise.all(Array.from({ length: 5 }, () => accept(db, quoteId, hash)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => r.approval_id)).size).toBe(1);
    expect(new Set(results.map((r) => r.purchase_id)).size).toBe(1);
    expect(results.filter((r) => r.already === false)).toHaveLength(1);
    const approvals = must(await db.from("approvals").select("id").eq("quote_version_id", quoteId));
    const purchases = must(await db.from("purchases").select("id").eq("quote_version_id", quoteId));
    expect(approvals).toHaveLength(1);
    expect(purchases).toHaveLength(1);
  });

  it("an accept racing a newer publish always leaves exactly one live quote, and it is the new one", async () => {
    for (let i = 0; i < 8; i++) {
      const { inquiryId } = await newInquiry(db);
      const v1 = await newDraft(db, inquiryId);
      const p1 = await publish(db, v1.quoteId);
      const v2 = await newDraft(db, inquiryId);
      const [acc, pub] = await Promise.all([accept(db, v1.quoteId, p1.hash), publish(db, v2.quoteId)]);

      expect(pub.ok).toBe(true);
      expect(await statusOf(db, v1.quoteId)).toBe("SUPERSEDED");
      expect(await statusOf(db, v2.quoteId)).toBe("PUBLISHED");
      const live = must(await db.from("quote_versions").select("id").eq("inquiry_id", inquiryId).in("status", ["PUBLISHED", "ACCEPTED"]));
      expect(live).toHaveLength(1);

      if (acc.ok) {
        // Accept won the lock first; the publish then superseded it and reported the purchase.
        expect(pub.invalidated_purchase_ids).toEqual([acc.purchase_id]);
      } else {
        // Publish won the lock first; the accept got a coded refusal and created nothing.
        expect(acc.code).toBe("SUPERSEDED");
        expect(must(await db.from("approvals").select("id").eq("quote_version_id", v1.quoteId))).toHaveLength(0);
      }
    }
  });
});

describe("function privileges", () => {
  it.each([
    ["create_quote_draft", { p_inquiry_id: "00000000-0000-4000-8000-000000000000", p_requirement_version_id: null, p_lines: {}, p_total_minor: 1, p_pending_conditions: [] }],
    ["publish_quote", { p_quote_id: "00000000-0000-4000-8000-000000000000", p_hash: "a".repeat(64), p_now: NOW }],
    ["accept_quote", { p_quote_id: "00000000-0000-4000-8000-000000000000", p_expected_hash: "a".repeat(64), p_terms_text: "t", p_now: NOW, p_validity_hours: 72 }],
  ])("%s cannot be called by the anon role", async (fn, args) => {
    const result = await anonClient().rpc(fn, args);
    expect(codeOf(result)).toBe(SQLSTATE.denied);
  });
});
