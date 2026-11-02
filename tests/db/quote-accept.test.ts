// Real local Postgres. Seeds the demo merchant itself (the run starts from an empty schema).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { TERMS_SENTENCE } from "@/domain/quote";
import { createCustomerLink } from "@/lib/access/customer-link";
import { authorizeCustomerLink, type VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { acceptQuote } from "@/services/quote/accept";
import { createQuoteDraft } from "@/services/quote/create-draft";
import { publishQuote } from "@/services/quote/publish";
import { verifyApprovalBinding } from "@/services/quote/verify-binding";
import { businessRules, merchant, MERCHANT_ID, PRODUCT_IDS, products, stock } from "../../supabase/seed/fixtures";
import { must, randomHash, serviceClient } from "./helpers";
import { accept as rpcAccept, newDraft, publish as rpcPublish, rpc, statusOf } from "./quote-helpers";

const db = serviceClient();
const SECRET = "db-test-secret-with-enough-length";
const T0 = "2026-11-03T10:00:00.000Z"; // publish time
const ctx = { now: T0, correlationId: "corr-quote-t6-test" };
const at = (iso: string) => ({ ...ctx, now: iso });
const system = { kind: "system" } as const;

const requirements = { noFood: true, logoRequired: true, maxPricePerBoxMinor: 3999 };
const box30 = {
  boxCount: 30,
  selections: { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "ORGANIZER-DESK", card: "CARD-BRANDED", packaging: "PACK-BOX" },
};

async function newInquiry(): Promise<string> {
  return must(await db.from("inquiries").insert({ merchant_id: MERCHANT_ID }).select("id").single(), "inquiry").id as string;
}

async function verified(inquiryId: string): Promise<VerifiedInquiryId> {
  const token = createCustomerLink({ inquiryId, version: 1, expiresAt: new Date("2030-01-01T00:00:00Z"), secret: SECRET });
  const result = await authorizeCustomerLink(db, token, { secret: SECRET, now: new Date(T0) });
  if (!result.ok) throw new Error("expected a valid link");
  return result.inquiry.id;
}

/** A published quote for a fresh inquiry, created through the real services. */
async function published(conditions: unknown[] = []) {
  const inquiryId = await newInquiry();
  const draft = await createQuoteDraft(db, { inquiryId, configuration: box30, requirements, requirementVersionId: null, conditions }, ctx);
  if (!draft.ok) throw new Error(`draft: ${draft.code}`);
  const pub = await publishQuote(db, draft.value.quoteId, system, ctx);
  if (!pub.ok) throw new Error(`publish: ${pub.code}`);
  return { inquiryId, quoteId: draft.value.quoteId, hash: pub.value.hash, who: await verified(inquiryId) };
}

const count = async (table: string, column: string, id: string) => must(await db.from(table).select("id").eq(column, id)).length;

async function auditActions(entityId: string) {
  return must(await db.from("audit_events").select("action, actor, data").eq("entity", "quote_version").eq("entity_id", entityId).order("id")) as Array<{
    action: string;
    actor: string;
    data: Record<string, unknown>;
  }>;
}

beforeAll(async () => {
  must(await db.from("merchants").upsert(merchant, { onConflict: "id" }), "merchant");
  must(await db.from("products").upsert(products, { onConflict: "id" }), "products");
  must(await db.from("stock").upsert(stock, { onConflict: "product_id" }), "stock");
  must(await db.from("business_rules").upsert(businessRules, { onConflict: "merchant_id,key" }), "rules");
});

describe("acceptQuote", () => {
  it("creates one approval and one purchase bound to the hash, with the exact terms", async () => {
    const q = await published([{ code: "PRODUCTION_SLOT_CONFIRMATION", text: "Production slot to be confirmed." }]);
    const r = await acceptQuote(db, q.who, q.quoteId, q.hash, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(await statusOf(db, q.quoteId)).toBe("ACCEPTED");
    const approval = must(await db.from("approvals").select("quote_hash, terms_text, quote_version_id").eq("id", r.value.approvalId).single());
    expect(approval.quote_hash).toBe(q.hash);
    expect(approval.quote_version_id).toBe(q.quoteId);
    expect(approval.terms_text).toContain(TERMS_SENTENCE);
    expect(approval.terms_text).toContain("$1,080.00");
    expect(approval.terms_text).toContain("Production slot to be confirmed.");
    const purchase = must(await db.from("purchases").select("merchant_id, inquiry_id, approval_id").eq("id", r.value.purchaseId).single());
    expect(purchase).toEqual({ merchant_id: MERCHANT_ID, inquiry_id: q.inquiryId, approval_id: r.value.approvalId });

    const events = await auditActions(q.quoteId);
    expect(events.at(-1)).toMatchObject({ action: "quote.accepted", actor: `customer:${q.inquiryId}` });
    expect(events.at(-1)!.data).toMatchObject({ from: "PUBLISHED", to: "ACCEPTED", quote_hash: q.hash, purchase_id: r.value.purchaseId });
  });

  it("is idempotent: a second accept returns the same ids and no second audit event", async () => {
    const q = await published();
    const first = await acceptQuote(db, q.who, q.quoteId, q.hash, ctx);
    const second = await acceptQuote(db, q.who, q.quoteId, q.hash, ctx);
    expect(first.ok && second.ok && second.value).toEqual(first.ok ? first.value : null);
    expect((await auditActions(q.quoteId)).filter((e) => e.action === "quote.accepted")).toHaveLength(1);
  });

  it("five simultaneous accepts (a double click, two tabs) leave one approval and one purchase", async () => {
    const q = await published();
    const results = await Promise.all(Array.from({ length: 5 }, () => acceptQuote(db, q.who, q.quoteId, q.hash, ctx)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => (r.ok ? r.value.approvalId : ""))).size).toBe(1);
    expect(await count("approvals", "quote_version_id", q.quoteId)).toBe(1);
    expect(await count("purchases", "quote_version_id", q.quoteId)).toBe(1);
    expect((await auditActions(q.quoteId)).filter((e) => e.action === "quote.accepted")).toHaveLength(1);
  });

  it("refuses a hash other than the one the customer was shown", async () => {
    const q = await published();
    expect(await acceptQuote(db, q.who, q.quoteId, randomHash(), ctx)).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
    expect(await statusOf(db, q.quoteId)).toBe("PUBLISHED");
    expect(await count("approvals", "quote_version_id", q.quoteId)).toBe(0);
  });

  it("refuses a quote of another customer and an unknown quote, with the same answer", async () => {
    const q = await published();
    const other = await verified(await newInquiry());
    expect(await acceptQuote(db, other, q.quoteId, q.hash, ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await acceptQuote(db, q.who, randomUUID(), q.hash, ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await count("approvals", "quote_version_id", q.quoteId)).toBe(0);
  });

  it("refuses a draft, a superseded quote and a withdrawn quote with their own codes", async () => {
    const q = await published();
    const newer = await createQuoteDraft(db, { inquiryId: q.inquiryId, configuration: box30, requirements, requirementVersionId: null, conditions: [] }, ctx);
    if (!newer.ok) throw new Error("draft");
    expect(await acceptQuote(db, q.who, newer.value.quoteId, randomHash(), ctx)).toMatchObject({ ok: false, code: "NOT_PUBLISHED" });
    const pub = await publishQuote(db, newer.value.quoteId, system, ctx);
    expect(await acceptQuote(db, q.who, q.quoteId, q.hash, ctx)).toMatchObject({ ok: false, code: "SUPERSEDED" });
    must(await db.from("quote_versions").update({ status: "WITHDRAWN" }).eq("id", newer.value.quoteId));
    expect(await acceptQuote(db, q.who, newer.value.quoteId, pub.ok ? pub.value.hash : "", ctx)).toMatchObject({ ok: false, code: "WITHDRAWN" });
  });

  describe("expiry", () => {
    it("accepts at exactly 72 hours and refuses one millisecond later, marking the quote EXPIRED", async () => {
      const ok = await published();
      expect((await acceptQuote(db, ok.who, ok.quoteId, ok.hash, at("2026-11-06T10:00:00.000Z"))).ok).toBe(true);

      const late = await published();
      expect(await acceptQuote(db, late.who, late.quoteId, late.hash, at("2026-11-06T10:00:00.001Z"))).toMatchObject({ ok: false, code: "EXPIRED" });
      expect(await statusOf(db, late.quoteId)).toBe("EXPIRED");
      expect((await auditActions(late.quoteId)).at(-1)).toMatchObject({ action: "quote.expired" });
    });

    it("uses the merchant's quote_validity_hours rule when set", async () => {
      must(await db.from("business_rules").upsert({ merchant_id: MERCHANT_ID, key: "quote_validity_hours", value: { hours: 1 } }, { onConflict: "merchant_id,key" }));
      try {
        const q = await published();
        expect(await acceptQuote(db, q.who, q.quoteId, q.hash, at("2026-11-03T11:00:00.001Z"))).toMatchObject({ ok: false, code: "EXPIRED" });
        const fine = await published();
        expect((await acceptQuote(db, fine.who, fine.quoteId, fine.hash, at("2026-11-03T11:00:00.000Z"))).ok).toBe(true);
      } finally {
        must(await db.from("business_rules").delete().eq("merchant_id", MERCHANT_ID).eq("key", "quote_validity_hours"));
      }
    });
  });

  describe("revalidation against the current catalog", () => {
    it("refuses with QUOTE_STALE when a price has changed since publishing", async () => {
      const q = await published();
      must(await db.from("products").update({ unit_price_minor: 1401 }).eq("id", PRODUCT_IDS.organizer));
      try {
        expect(await acceptQuote(db, q.who, q.quoteId, q.hash, ctx)).toMatchObject({ ok: false, code: "QUOTE_STALE" });
        expect(await statusOf(db, q.quoteId)).toBe("PUBLISHED");
        expect(await count("approvals", "quote_version_id", q.quoteId)).toBe(0);
      } finally {
        must(await db.from("products").update({ unit_price_minor: 1400 }).eq("id", PRODUCT_IDS.organizer));
      }
    });

    it("refuses with the stock blocker when the stock is gone", async () => {
      const q = await published();
      must(await db.from("stock").update({ on_hand: 10 }).eq("product_id", PRODUCT_IDS.organizer));
      try {
        const r = await acceptQuote(db, q.who, q.quoteId, q.hash, ctx);
        expect(r).toMatchObject({ ok: false, code: "CONFIGURATION_BLOCKED" });
        expect(!r.ok && r.blockers).toContainEqual(expect.objectContaining({ code: "INSUFFICIENT_STOCK", needed: 30, available: 10 }));
        expect(await count("approvals", "quote_version_id", q.quoteId)).toBe(0);
      } finally {
        must(await db.from("stock").update({ on_hand: 100 }).eq("product_id", PRODUCT_IDS.organizer));
      }
    });

    it("refuses when a product has been deactivated", async () => {
      const q = await published();
      must(await db.from("products").update({ active: false }).eq("id", PRODUCT_IDS.organizer));
      try {
        const r = await acceptQuote(db, q.who, q.quoteId, q.hash, ctx);
        expect(!r.ok && r.blockers).toContainEqual(expect.objectContaining({ code: "INACTIVE_PRODUCT" }));
      } finally {
        must(await db.from("products").update({ active: true }).eq("id", PRODUCT_IDS.organizer));
      }
    });
  });

  describe("tamper detection", () => {
    it("refuses a published row whose stored hash is not the hash of its content", async () => {
      // A compromised caller publishes a draft with a made-up hash. The customer is shown that hash.
      const inquiryId = await newInquiry();
      const { quoteId } = await newDraftWithRealLines(inquiryId);
      const fake = randomHash();
      expect((await rpcPublish(db, quoteId, fake)).ok).toBe(true);
      const who = await verified(inquiryId);
      expect(await acceptQuote(db, who, quoteId, fake, ctx)).toMatchObject({ ok: false, code: "QUOTE_TAMPERED" });
      expect(await statusOf(db, quoteId)).toBe("PUBLISHED");
    });

    it("refuses a row whose lines do not fit the stored shape", async () => {
      const inquiryId = await newInquiry();
      const { quoteId } = await newDraft(db, inquiryId); // helper stores empty lines
      const fake = randomHash();
      await rpcPublish(db, quoteId, fake);
      expect(await acceptQuote(db, await verified(inquiryId), quoteId, fake, ctx)).toMatchObject({ ok: false, code: "QUOTE_TAMPERED" });
    });

    it("refuses a row whose total does not match its lines", async () => {
      const inquiryId = await newInquiry();
      const lines = { boxCount: 2, perBoxMinor: 100, lines: [{ slotId: "a", sku: "X", name: "X", unitPriceMinor: 100, quantity: 1 }] };
      const r = await rpc(db, "create_quote_draft", { p_inquiry_id: inquiryId, p_requirement_version_id: null, p_lines: lines, p_total_minor: 999, p_pending_conditions: [] });
      const fake = randomHash();
      await rpcPublish(db, r.quote_id!, fake);
      expect(await acceptQuote(db, await verified(inquiryId), r.quote_id!, fake, ctx)).toMatchObject({ ok: false, code: "QUOTE_TAMPERED" });
    });
  });
});

/** A draft with real, consistent lines but written directly, so the test can publish it with any hash. */
async function newDraftWithRealLines(inquiryId: string): Promise<{ quoteId: string }> {
  const lines = {
    boxCount: 30,
    perBoxMinor: 3600,
    lines: [
      { slotId: "notebook", sku: "NOTEBOOK-A5", name: "A5 notebook", unitPriceMinor: 1200, quantity: 1 },
      { slotId: "pen", sku: "PEN-BLK", name: "Black gel pen", unitPriceMinor: 300, quantity: 1 },
      { slotId: "gift", sku: "ORGANIZER-DESK", name: "Desk organizer", unitPriceMinor: 1400, quantity: 1 },
      { slotId: "card", sku: "CARD-BRANDED", name: "Branded welcome card", unitPriceMinor: 200, quantity: 1 },
      { slotId: "packaging", sku: "PACK-BOX", name: "Gift box", unitPriceMinor: 500, quantity: 1 },
    ],
  };
  const r = await rpc(db, "create_quote_draft", { p_inquiry_id: inquiryId, p_requirement_version_id: null, p_lines: lines, p_total_minor: 108000, p_pending_conditions: [] });
  return { quoteId: r.quote_id! };
}

describe("verifyApprovalBinding", () => {
  async function accepted() {
    const q = await published();
    const r = await acceptQuote(db, q.who, q.quoteId, q.hash, ctx);
    if (!r.ok) throw new Error(`accept: ${r.code}`);
    return { ...q, approvalId: r.value.approvalId, purchaseId: r.value.purchaseId };
  }

  it("returns the accepted snapshot: the amount, currency and hash payments must use", async () => {
    const a = await accepted();
    const r = await verifyApprovalBinding(db, a.approvalId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ quoteId: a.quoteId, purchaseId: a.purchaseId, quoteHash: a.hash });
    expect(r.value.snapshot).toMatchObject({ totalMinor: 108000, perBoxMinor: 3600, boxCount: 30, currency: "USD", inquiryId: a.inquiryId });
  });

  it("refuses an unknown approval", async () => {
    expect(await verifyApprovalBinding(db, randomUUID())).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("old acceptance cannot authorize payment once a newer version replaces the quote (brief row)", async () => {
    const a = await accepted();
    const newer = await createQuoteDraft(db, { inquiryId: a.inquiryId, configuration: { ...box30, boxCount: 31 }, requirements, requirementVersionId: null, conditions: [] }, ctx);
    if (!newer.ok) throw new Error("draft");
    expect((await publishQuote(db, newer.value.quoteId, system, ctx)).ok).toBe(true);
    expect(await verifyApprovalBinding(db, a.approvalId)).toMatchObject({ ok: false, code: "SUPERSEDED" });
  });

  it("refuses an approval whose hash differs from the quote's", async () => {
    const q = await published();
    const approval = must(await db.from("approvals").insert({ quote_version_id: q.quoteId, quote_hash: randomHash(), terms_text: "t" }).select("id").single());
    must(await db.from("quote_versions").update({ status: "ACCEPTED" }).eq("id", q.quoteId));
    expect(await verifyApprovalBinding(db, approval.id)).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
  });

  it("refuses an accepted quote whose stored hash is not the hash of its content", async () => {
    const inquiryId = await newInquiry();
    const { quoteId } = await newDraftWithRealLines(inquiryId);
    const fake = randomHash();
    await rpcPublish(db, quoteId, fake);
    const acc = await rpcAccept(db, quoteId, fake);
    expect(acc.ok).toBe(true);
    expect(await verifyApprovalBinding(db, acc.approval_id!)).toMatchObject({ ok: false, code: "QUOTE_TAMPERED" });
  });
});
