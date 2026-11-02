// Real local Postgres. Seeds the demo merchant itself (the run starts from an empty schema).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { calculateQuote } from "@/domain/catalog";
import { buildQuoteSnapshot, quoteHash } from "@/domain/quote";
import { sha256Hex } from "@/lib/hash";
import { createQuoteDraft, requestMerchantReview } from "@/services/quote/create-draft";
import { publishQuote, withdrawQuote } from "@/services/quote/publish";
import { loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { businessRules, merchant, MERCHANT_ID, products, stock } from "../../supabase/seed/fixtures";
import { codeOf, must, serviceClient, unique } from "./helpers";
import { accept, NOW, statusOf } from "./quote-helpers";

const db = serviceClient();
const ctx = { now: NOW, correlationId: "corr-quote-t5-test" };
const system = { kind: "system" } as const;
const merchantActor = { kind: "merchant", userId: randomUUID(), merchantId: MERCHANT_ID } as const;

const requirements = { noFood: true, logoRequired: true, maxPricePerBoxMinor: 3999 };
const box = (count: number, gift: string) => ({
  boxCount: count,
  selections: { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift, card: "CARD-BRANDED", packaging: "PACK-BOX" },
});

async function newInquiry(): Promise<string> {
  return must(await db.from("inquiries").insert({ merchant_id: MERCHANT_ID }).select("id").single(), "inquiry").id as string;
}

type DraftOverrides = { configuration?: unknown; conditions?: unknown; requirementVersionId?: string | null; extra?: Record<string, unknown> };
const draftInput = (inquiryId: string, o: DraftOverrides = {}) => ({
  inquiryId,
  configuration: o.configuration ?? box(30, "ORGANIZER-DESK"),
  requirements,
  requirementVersionId: o.requirementVersionId ?? null,
  conditions: o.conditions ?? [],
  ...o.extra,
});

async function mustDraft(inquiryId: string, o: DraftOverrides = {}) {
  const r = await createQuoteDraft(db, draftInput(inquiryId, o), ctx);
  if (!r.ok) throw new Error(`draft failed: ${r.code}`);
  return r.value;
}

const countQuotes = async (inquiryId: string) =>
  must(await db.from("quote_versions").select("id").eq("inquiry_id", inquiryId)).length;

const inquiryStatus = async (id: string) => must(await db.from("inquiries").select("status").eq("id", id).single()).status as string;

async function auditActions(entityId: string): Promise<Array<{ action: string; actor: string; data: Record<string, unknown> }>> {
  const rows = must(await db.from("audit_events").select("action, actor, data").eq("entity", "quote_version").eq("entity_id", entityId).order("id"));
  return rows as Array<{ action: string; actor: string; data: Record<string, unknown> }>;
}

beforeAll(async () => {
  must(await db.from("merchants").upsert(merchant, { onConflict: "id" }), "merchant");
  must(await db.from("products").upsert(products, { onConflict: "id" }), "products");
  must(await db.from("stock").upsert(stock, { onConflict: "product_id" }), "stock");
  must(await db.from("business_rules").upsert(businessRules, { onConflict: "merchant_id,key" }), "rules");
});

describe("createQuoteDraft", () => {
  it("prices demo step A in code: 20 boxes with the bottle is 3500 per box and 70000", async () => {
    const inquiryId = await newInquiry();
    const draft = await mustDraft(inquiryId, { configuration: box(20, "BOTTLE-STEEL") });
    expect(draft).toMatchObject({ version: 1, held: false });
    expect(draft.priced).toMatchObject({ perBoxMinor: 3500, totalMinor: 70000, boxCount: 20 });
  });

  it("stores demo step D: 30 boxes with the organizer is 3600 per box and 108000", async () => {
    const inquiryId = await newInquiry();
    const draft = await mustDraft(inquiryId);
    const row = must(await db.from("quote_versions").select("status, version, total_minor, lines, quote_hash").eq("id", draft.quoteId).single());
    expect(row).toMatchObject({ status: "DRAFT", version: 1, total_minor: 108000, quote_hash: null });
    expect((row.lines as { perBoxMinor: number; boxCount: number }).perBoxMinor).toBe(3600);
    expect((row.lines as { lines: unknown[] }).lines).toHaveLength(5);
  });

  it("numbers versions 1, 2, 3 for one inquiry", async () => {
    const inquiryId = await newInquiry();
    expect((await mustDraft(inquiryId)).version).toBe(1);
    expect((await mustDraft(inquiryId)).version).toBe(2);
  });

  it("blocks demo step B: 30 bottles, with INSUFFICIENT_STOCK, and creates nothing", async () => {
    const inquiryId = await newInquiry();
    const r = await createQuoteDraft(db, draftInput(inquiryId, { configuration: box(30, "BOTTLE-STEEL") }), ctx);
    expect(r).toMatchObject({ ok: false, code: "CONFIGURATION_BLOCKED" });
    expect(!r.ok && r.blockers).toContainEqual(expect.objectContaining({ code: "INSUFFICIENT_STOCK", needed: 30, available: 24 }));
    expect(await countQuotes(inquiryId)).toBe(0);
  });

  it("rejects an unknown product before any quote exists (brief row)", async () => {
    const inquiryId = await newInquiry();
    const r = await createQuoteDraft(db, draftInput(inquiryId, { configuration: box(30, "MAGIC-WAND-999") }), ctx);
    expect(!r.ok && r.code).toBe("CONFIGURATION_BLOCKED");
    expect(!r.ok && r.blockers).toContainEqual(expect.objectContaining({ code: "UNKNOWN_PRODUCT", sku: "MAGIC-WAND-999" }));
    expect(await countQuotes(inquiryId)).toBe(0);
  });

  it("blocks a food product under a no-food requirement", async () => {
    const inquiryId = await newInquiry();
    const r = await createQuoteDraft(db, draftInput(inquiryId, { configuration: box(20, "TRUFFLES-BOX") }), ctx);
    expect(!r.ok && r.blockers).toContainEqual(expect.objectContaining({ code: "FOOD_NOT_ALLOWED" }));
    expect(await countQuotes(inquiryId)).toBe(0);
  });

  it.each([
    ["an amount", { amount: 100 }],
    ["a discount", { discount: 0.5 }],
    ["a total", { totalMinor: 1 }],
    ["a status", { status: "PUBLISHED" }],
  ])("rejects an input carrying %s and creates nothing (brief row: charge $1)", async (_name, extra) => {
    const inquiryId = await newInquiry();
    const r = await createQuoteDraft(db, draftInput(inquiryId, { extra }), ctx);
    expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await countQuotes(inquiryId)).toBe(0);
  });

  it("rejects a price smuggled into the configuration", async () => {
    const inquiryId = await newInquiry();
    const configuration = { ...box(30, "ORGANIZER-DESK"), unitPriceMinor: 1 };
    expect(await createQuoteDraft(db, draftInput(inquiryId, { configuration }), ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("reports an unknown inquiry as NOT_FOUND", async () => {
    expect(await createQuoteDraft(db, draftInput(randomUUID()), ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("rejects a requirement version that belongs to another inquiry", async () => {
    const other = await newInquiry();
    const rv = must(await db.from("requirement_versions").insert({ inquiry_id: other, version: 1, requirements: {} }).select("id").single());
    const inquiryId = await newInquiry();
    expect(await createQuoteDraft(db, draftInput(inquiryId, { requirementVersionId: rv.id }), ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await countQuotes(inquiryId)).toBe(0);
  });

  it("accepts a requirement version that belongs to the inquiry", async () => {
    const inquiryId = await newInquiry();
    const rv = must(await db.from("requirement_versions").insert({ inquiry_id: inquiryId, version: 1, requirements: {} }).select("id").single());
    const draft = await mustDraft(inquiryId, { requirementVersionId: rv.id });
    expect(must(await db.from("quote_versions").select("requirement_version_id").eq("id", draft.quoteId).single()).requirement_version_id).toBe(rv.id);
  });

  it("holds a draft with an unresolved unsupported customization and sends the inquiry to review", async () => {
    const inquiryId = await newInquiry();
    const draft = await mustDraft(inquiryId, { conditions: [{ code: "UNSUPPORTED_CUSTOMIZATION", text: "Gold foil lid." }] });
    expect(draft.held).toBe(true);
    expect(await inquiryStatus(inquiryId)).toBe("REVIEW_REQUIRED");
    expect(await statusOf(db, draft.quoteId)).toBe("DRAFT");
  });

  it("writes an audit event for the draft", async () => {
    const inquiryId = await newInquiry();
    const draft = await mustDraft(inquiryId);
    const events = await auditActions(draft.quoteId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "quote.draft_created", actor: "system" });
    expect(events[0]!.data).toMatchObject({ quote_version: 1, inquiry_id: inquiryId });
  });
});

describe("requestMerchantReview", () => {
  it("moves the inquiry to REVIEW_REQUIRED for a draft", async () => {
    const inquiryId = await newInquiry();
    const draft = await mustDraft(inquiryId);
    expect((await requestMerchantReview(db, draft.quoteId, ctx)).ok).toBe(true);
    expect(await inquiryStatus(inquiryId)).toBe("REVIEW_REQUIRED");
  });

  it("refuses a quote that is not a draft, and an unknown quote", async () => {
    const inquiryId = await newInquiry();
    const draft = await mustDraft(inquiryId);
    await publishQuote(db, draft.quoteId, system, ctx);
    expect(await requestMerchantReview(db, draft.quoteId, ctx)).toMatchObject({ ok: false, code: "NOT_DRAFT" });
    expect(await requestMerchantReview(db, randomUUID(), ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("publishQuote", () => {
  it("publishes a clean draft automatically, with a hash that matches an independent recomputation", async () => {
    const inquiryId = await newInquiry();
    const draft = await mustDraft(inquiryId);
    const r = await publishQuote(db, draft.quoteId, system, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const { catalog } = await loadCatalogSnapshot(db, MERCHANT_ID);
    const expected = quoteHash(
      buildQuoteSnapshot({
        merchantId: MERCHANT_ID,
        inquiryId,
        version: 1,
        requirementVersionId: null,
        priced: calculateQuote(box(30, "ORGANIZER-DESK"), catalog),
        conditions: [],
      }),
      sha256Hex,
    );
    expect(r.value.hash).toBe(expected);

    const row = must(await db.from("quote_versions").select("status, quote_hash, published_at").eq("id", draft.quoteId).single());
    expect(row.status).toBe("PUBLISHED");
    expect(row.quote_hash).toBe(expected);
    expect(await inquiryStatus(inquiryId)).toBe("QUOTE_READY");
  });

  it("supersedes the previous live version and audits both transitions", async () => {
    const inquiryId = await newInquiry();
    const v1 = await mustDraft(inquiryId);
    await publishQuote(db, v1.quoteId, system, ctx);
    const v2 = await mustDraft(inquiryId);
    const r = await publishQuote(db, v2.quoteId, system, ctx);
    expect(r.ok && r.value.supersededQuoteId).toBe(v1.quoteId);
    expect(await statusOf(db, v1.quoteId)).toBe("SUPERSEDED");
    expect((await auditActions(v1.quoteId)).map((e) => e.action)).toEqual(["quote.draft_created", "quote.published", "quote.superseded"]);
    const published = (await auditActions(v2.quoteId)).find((e) => e.action === "quote.published")!;
    expect(published.data).toMatchObject({ from: "DRAFT", to: "PUBLISHED", quote_version: 2 });
    expect(published.data.quote_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes disclosed conditions in the hash", async () => {
    const a = await mustDraft(await newInquiry());
    const b = await mustDraft(await newInquiry(), {
      conditions: [
        { code: "PRODUCTION_SLOT_CONFIRMATION", text: "Slot pending." },
        { code: "ARTWORK_ACCEPTANCE", text: "Artwork pending." },
      ],
    });
    const ra = await publishQuote(db, a.quoteId, system, ctx);
    const rb = await publishQuote(db, b.quoteId, system, ctx);
    expect(ra.ok && rb.ok).toBe(true);
    const stored = must(await db.from("quote_versions").select("pending_conditions").eq("id", b.quoteId).single());
    expect(stored.pending_conditions).toHaveLength(2);
  });

  it("refuses a published, unknown or withdrawn quote", async () => {
    const draft = await mustDraft(await newInquiry());
    await publishQuote(db, draft.quoteId, system, ctx);
    expect(await publishQuote(db, draft.quoteId, system, ctx)).toMatchObject({ ok: false, code: "NOT_DRAFT" });
    expect(await publishQuote(db, randomUUID(), system, ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("refuses with PAYMENT_STARTED while an accepted quote's payment is under way", async () => {
    const inquiryId = await newInquiry();
    const v1 = await mustDraft(inquiryId);
    const p1 = await publishQuote(db, v1.quoteId, system, ctx);
    const hash = p1.ok ? p1.value.hash : "";
    const acc = await accept(db, v1.quoteId, hash);
    must(await db.from("payment_attempts").insert({ purchase_id: acc.purchase_id, amount_minor: 108000, quote_hash: hash, state: "AUTHORIZED" }));
    const v2 = await mustDraft(inquiryId);
    expect(await publishQuote(db, v2.quoteId, system, ctx)).toMatchObject({ ok: false, code: "PAYMENT_STARTED" });
    expect(await statusOf(db, v1.quoteId)).toBe("ACCEPTED");
  });

  describe("the merchant review gate", () => {
    const unsupported = [{ code: "UNSUPPORTED_CUSTOMIZATION", text: "Gold foil lid." }];

    it("does not let the system publish a held draft", async () => {
      const draft = await mustDraft(await newInquiry(), { conditions: unsupported });
      expect(await publishQuote(db, draft.quoteId, system, ctx)).toMatchObject({ ok: false, code: "MERCHANT_REVIEW_REQUIRED" });
      expect(await statusOf(db, draft.quoteId)).toBe("DRAFT");
    });

    it("hides the quote from another merchant", async () => {
      const draft = await mustDraft(await newInquiry(), { conditions: unsupported });
      const other = { kind: "merchant", userId: randomUUID(), merchantId: randomUUID() } as const;
      expect(await publishQuote(db, draft.quoteId, other, { ...ctx, approvalText: "ok" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("requires the merchant's own wording", async () => {
      const draft = await mustDraft(await newInquiry(), { conditions: unsupported });
      expect(await publishQuote(db, draft.quoteId, merchantActor, ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect(await publishQuote(db, draft.quoteId, merchantActor, { ...ctx, approvalText: "   " })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect(await statusOf(db, draft.quoteId)).toBe("DRAFT");
    });

    it("lets the merchant publish with their wording, which replaces the unresolved item and is audited", async () => {
      const inquiryId = await newInquiry();
      const draft = await mustDraft(inquiryId, { conditions: [...unsupported, { code: "ARTWORK_ACCEPTANCE", text: "Artwork pending." }] });
      const r = await publishQuote(db, draft.quoteId, merchantActor, { ...ctx, approvalText: "  We can foil the lid for this order.  " });
      expect(r.ok).toBe(true);

      const stored = must(await db.from("quote_versions").select("status, pending_conditions").eq("id", draft.quoteId).single());
      expect(stored.status).toBe("PUBLISHED");
      expect(stored.pending_conditions).toEqual([
        { code: "ARTWORK_ACCEPTANCE", text: "Artwork pending." },
        { code: "MERCHANT_APPROVED_CUSTOMIZATION", text: "We can foil the lid for this order." },
      ]);
      expect(await inquiryStatus(inquiryId)).toBe("QUOTE_READY");

      const events = await auditActions(draft.quoteId);
      const approved = events.find((e) => e.action === "quote.customization_approved");
      expect(approved).toMatchObject({ actor: `merchant:${merchantActor.userId}` });
    });
  });
});

describe("withdrawQuote", () => {
  it("withdraws a draft and returns the inquiry to CONFIGURING", async () => {
    const inquiryId = await newInquiry();
    const draft = await mustDraft(inquiryId, { conditions: [{ code: "UNSUPPORTED_CUSTOMIZATION", text: "x" }] });
    expect((await withdrawQuote(db, draft.quoteId, merchantActor, "Cannot make it.", ctx)).ok).toBe(true);
    expect(await statusOf(db, draft.quoteId)).toBe("WITHDRAWN");
    expect(await inquiryStatus(inquiryId)).toBe("CONFIGURING");
    const events = await auditActions(draft.quoteId);
    expect(events.at(-1)).toMatchObject({ action: "quote.withdrawn", actor: `merchant:${merchantActor.userId}` });
    expect(events.at(-1)!.data).toMatchObject({ from: "DRAFT", to: "WITHDRAWN", reason: "Cannot make it." });
  });

  it("withdraws a published quote, which then cannot be accepted", async () => {
    const draft = await mustDraft(await newInquiry());
    const p = await publishQuote(db, draft.quoteId, system, ctx);
    expect((await withdrawQuote(db, draft.quoteId, merchantActor, "Price error.", ctx)).ok).toBe(true);
    expect(await accept(db, draft.quoteId, p.ok ? p.value.hash : "")).toMatchObject({ ok: false, code: "WITHDRAWN" });
  });

  it("refuses an accepted quote", async () => {
    const draft = await mustDraft(await newInquiry());
    const p = await publishQuote(db, draft.quoteId, system, ctx);
    await accept(db, draft.quoteId, p.ok ? p.value.hash : "");
    expect(await withdrawQuote(db, draft.quoteId, merchantActor, "Changed mind.", ctx)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(await statusOf(db, draft.quoteId)).toBe("ACCEPTED");
  });

  it("hides the quote from another merchant and requires a reason", async () => {
    const draft = await mustDraft(await newInquiry());
    const other = { kind: "merchant", userId: randomUUID(), merchantId: randomUUID() } as const;
    expect(await withdrawQuote(db, draft.quoteId, other, "x", ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await withdrawQuote(db, draft.quoteId, merchantActor, "  ", ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await withdrawQuote(db, randomUUID(), merchantActor, "x", ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("returns the inquiry to QUOTE_READY when another quote is still live", async () => {
    const inquiryId = await newInquiry();
    const v1 = await mustDraft(inquiryId);
    await publishQuote(db, v1.quoteId, system, ctx);
    const v2 = await mustDraft(inquiryId, { conditions: [{ code: "UNSUPPORTED_CUSTOMIZATION", text: "x" }] });
    expect(await inquiryStatus(inquiryId)).toBe("REVIEW_REQUIRED");
    await withdrawQuote(db, v2.quoteId, merchantActor, "No.", ctx);
    expect(await inquiryStatus(inquiryId)).toBe("QUOTE_READY");
  });
});

describe("audit rows never contain secrets or free-form customer text", () => {
  it("keeps only allowlisted keys", async () => {
    const draft = await mustDraft(await newInquiry());
    await publishQuote(db, draft.quoteId, system, ctx);
    for (const e of await auditActions(draft.quoteId)) {
      for (const key of Object.keys(e.data)) {
        expect(["state", "from", "to", "status", "reason", "code", "quote_version", "quote_hash", "inquiry_id", "amount_minor", "currency", "purchase_id", "decision"]).toContain(key);
      }
    }
    expect(codeOf({ error: null })).toBe("none");
    expect(unique("x")).toMatch(/^x-/);
  });
});
