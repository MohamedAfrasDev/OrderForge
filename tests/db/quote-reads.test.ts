// Real local Postgres. Seeds the demo merchant itself (the run starts from an empty schema).
import { beforeAll, describe, expect, it } from "vitest";
import { createCustomerLink } from "@/lib/access/customer-link";
import { authorizeCustomerLink, type VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { acceptQuote } from "@/services/quote/accept";
import { createQuoteDraft } from "@/services/quote/create-draft";
import { publishQuote } from "@/services/quote/publish";
import { readCustomerQuote } from "@/services/quote/read";
import { businessRules, merchant, MERCHANT_ID, products, stock } from "../../supabase/seed/fixtures";
import { must, serviceClient } from "./helpers";

const db = serviceClient();
const SECRET = "db-test-secret-with-enough-length";
const T0 = "2026-11-03T10:00:00.000Z";
const ctx = { now: T0, correlationId: "corr-quote-t7-test" };
const system = { kind: "system" } as const;
const requirements = { noFood: true, logoRequired: true, maxPricePerBoxMinor: 3999 };
const box = (count: number) => ({
  boxCount: count,
  selections: { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "ORGANIZER-DESK", card: "CARD-BRANDED", packaging: "PACK-BOX" },
});

async function newInquiry(): Promise<VerifiedInquiryId> {
  const row = must(await db.from("inquiries").insert({ merchant_id: MERCHANT_ID }).select("id").single(), "inquiry");
  const token = createCustomerLink({ inquiryId: row.id, version: 1, expiresAt: new Date("2030-01-01T00:00:00Z"), secret: SECRET });
  const access = await authorizeCustomerLink(db, token, { secret: SECRET, now: new Date(T0) });
  if (!access.ok) throw new Error("expected a valid link");
  return access.inquiry.id;
}

async function draft(inquiryId: string, boxes = 30, conditions: unknown[] = []) {
  const r = await createQuoteDraft(db, { inquiryId, configuration: box(boxes), requirements, requirementVersionId: null, conditions }, ctx);
  if (!r.ok) throw new Error(`draft: ${r.code}`);
  return r.value.quoteId;
}

async function published(inquiryId: string, boxes = 30, conditions: unknown[] = []) {
  const quoteId = await draft(inquiryId, boxes, conditions);
  const r = await publishQuote(db, quoteId, system, ctx);
  if (!r.ok) throw new Error(`publish: ${r.code}`);
  return { quoteId, hash: r.value.hash };
}

beforeAll(async () => {
  must(await db.from("merchants").upsert(merchant, { onConflict: "id" }), "merchant");
  must(await db.from("products").upsert(products, { onConflict: "id" }), "products");
  must(await db.from("stock").upsert(stock, { onConflict: "product_id" }), "stock");
  must(await db.from("business_rules").upsert(businessRules, { onConflict: "merchant_id,key" }), "rules");
});

describe("readCustomerQuote", () => {
  it("returns nothing for an inquiry with no quote, and never shows a draft", async () => {
    const id = await newInquiry();
    expect(await readCustomerQuote(db, id, T0)).toBeNull();
    await draft(id);
    expect(await readCustomerQuote(db, id, T0)).toBeNull();
  });

  it("shows a held draft to nobody", async () => {
    const id = await newInquiry();
    await draft(id, 30, [{ code: "UNSUPPORTED_CUSTOMIZATION", text: "Gold foil lid." }]);
    expect(await readCustomerQuote(db, id, T0)).toBeNull();
  });

  it("shows the published quote: lines, amounts, conditions, terms and the hash to accept", async () => {
    const id = await newInquiry();
    const { quoteId, hash } = await published(id, 30, [{ code: "ARTWORK_ACCEPTANCE", text: "Artwork to be accepted." }]);
    const view = await readCustomerQuote(db, id, T0);
    expect(view).toMatchObject({
      quoteId,
      version: 1,
      status: "PUBLISHED",
      hash,
      expired: false,
      acceptedAt: null,
      boxCount: 30,
      perBoxMinor: 3600,
      totalMinor: 108000,
      currency: "USD",
      conditions: [{ code: "ARTWORK_ACCEPTANCE", text: "Artwork to be accepted." }],
    });
    expect(view!.lines.map((l) => [l.name, l.quantity, l.unitPriceMinor])).toEqual([
      ["A5 notebook", 1, 1200],
      ["Black gel pen", 1, 300],
      ["Desk organizer", 1, 1400],
      ["Branded welcome card", 1, 200],
      ["Gift box packaging", 1, 500],
    ]);
    expect(view!.terms).toContain("You are authorizing this exact proposal");
    expect(view!.terms).toContain("$1,080.00");
    expect(view!.expiresAt).toBe("2026-11-06T10:00:00.000Z");
  });

  it("marks a quote past its validity window as expired, without changing it", async () => {
    const id = await newInquiry();
    await published(id);
    expect((await readCustomerQuote(db, id, "2026-11-06T10:00:00.000Z"))!.expired).toBe(false);
    expect((await readCustomerQuote(db, id, "2026-11-06T10:00:00.001Z"))!.expired).toBe(true);
  });

  it("shows the accepted quote with the time it was accepted", async () => {
    const id = await newInquiry();
    const { quoteId, hash } = await published(id);
    const accepted = await acceptQuote(db, id, quoteId, hash, { ...ctx, now: "2026-11-03T12:00:00.000Z" });
    expect(accepted.ok).toBe(true);
    const view = await readCustomerQuote(db, id, "2026-11-03T12:05:00.000Z");
    expect(view).toMatchObject({ status: "ACCEPTED", acceptedAt: "2026-11-03T12:00:00.000Z", expired: false });
  });

  it("an accepted quote never reads as expired", async () => {
    const id = await newInquiry();
    const { quoteId, hash } = await published(id);
    await acceptQuote(db, id, quoteId, hash, ctx);
    expect((await readCustomerQuote(db, id, "2027-01-01T00:00:00.000Z"))!.expired).toBe(false);
  });

  it("shows the newest version once an older one is superseded", async () => {
    const id = await newInquiry();
    await published(id, 30);
    const v2 = await published(id, 31);
    const view = await readCustomerQuote(db, id, T0);
    expect(view).toMatchObject({ quoteId: v2.quoteId, version: 2, boxCount: 31, hash: v2.hash });
  });

  it("returns only the verified inquiry's own quote", async () => {
    const a = await newInquiry();
    const b = await newInquiry();
    const qa = await published(a, 30);
    expect(await readCustomerQuote(db, b, T0)).toBeNull();
    const qb = await published(b, 12);
    expect((await readCustomerQuote(db, a, T0))!.quoteId).toBe(qa.quoteId);
    expect((await readCustomerQuote(db, b, T0))!.quoteId).toBe(qb.quoteId);
  });

  it("does not show a quote whose stored hash is not the hash of its content", async () => {
    const id = await newInquiry();
    const quoteId = await draft(id);
    must(
      await db.rpc("publish_quote", { p_quote_id: quoteId, p_hash: "f".repeat(64), p_now: T0 }),
    );
    expect(await readCustomerQuote(db, id, T0)).toBeNull();
  });

  it("leaks no merchant id, stock figure or other internal field", async () => {
    const id = await newInquiry();
    await published(id);
    const view = (await readCustomerQuote(db, id, T0))!;
    // The fixed terms sentence says "merchant" on purpose; every other field must carry no internal name.
    const { terms, ...rest } = view;
    expect(terms).toContain("merchant");
    const json = JSON.stringify(rest);
    expect(json).not.toContain(MERCHANT_ID);
    expect(json).not.toMatch(/merchant|stock|on_hand|reserved|inquiry/i);
    expect(Object.keys((await readCustomerQuote(db, id, T0))!).sort()).toEqual(
      ["acceptedAt", "boxCount", "conditions", "currency", "expired", "expiresAt", "hash", "lines", "perBoxMinor", "quoteId", "status", "terms", "totalMinor", "version"].sort(),
    );
  });
});
