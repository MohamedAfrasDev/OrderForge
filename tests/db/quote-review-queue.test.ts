// Real local Postgres. Seeds the demo merchant itself (the run starts from an empty schema).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createQuoteDraft } from "@/services/quote/create-draft";
import { publishQuote, withdrawQuote } from "@/services/quote/publish";
import { listReviewDrafts } from "@/services/quote/review-queue";
import { businessRules, merchant, MERCHANT_ID, products, stock } from "../../supabase/seed/fixtures";
import { createMerchantUser, must, serviceClient, signedInClient, unique } from "./helpers";

const db = serviceClient();
const ctx = { now: "2026-11-03T10:00:00.000Z", correlationId: "corr-quote-t8-test" };
const system = { kind: "system" } as const;
const requirements = { noFood: true, logoRequired: true, maxPricePerBoxMinor: 3999 };
const box = (count: number) => ({
  boxCount: count,
  selections: { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "ORGANIZER-DESK", card: "CARD-BRANDED", packaging: "PACK-BOX" },
});

async function newInquiry(merchantId = MERCHANT_ID): Promise<string> {
  return must(await db.from("inquiries").insert({ merchant_id: merchantId }).select("id").single(), "inquiry").id as string;
}

async function draft(inquiryId: string, boxes = 30, conditions: unknown[] = []) {
  const r = await createQuoteDraft(db, { inquiryId, configuration: box(boxes), requirements, requirementVersionId: null, conditions }, ctx);
  if (!r.ok) throw new Error(`draft: ${r.code}`);
  return r.value.quoteId;
}

beforeAll(async () => {
  must(await db.from("merchants").upsert(merchant, { onConflict: "id" }), "merchant");
  must(await db.from("products").upsert(products, { onConflict: "id" }), "products");
  must(await db.from("stock").upsert(stock, { onConflict: "product_id" }), "stock");
  must(await db.from("business_rules").upsert(businessRules, { onConflict: "merchant_id,key" }), "rules");
});

describe("listReviewDrafts", () => {
  it("lists drafts newest first with their amounts and flags the ones that need a decision", async () => {
    const held = await newInquiry();
    const heldQuote = await draft(held, 30, [{ code: "UNSUPPORTED_CUSTOMIZATION", text: "Gold foil lid." }]);
    const clean = await newInquiry();
    const cleanQuote = await draft(clean, 20, [{ code: "ARTWORK_ACCEPTANCE", text: "Artwork pending." }]);

    const list = await listReviewDrafts(db, MERCHANT_ID);
    const mine = list.filter((d) => [heldQuote, cleanQuote].includes(d.quoteId));
    expect(mine.map((d) => d.quoteId)).toEqual([cleanQuote, heldQuote]);

    const h = mine.find((d) => d.quoteId === heldQuote)!;
    expect(h).toMatchObject({ inquiryId: held, version: 1, boxCount: 30, perBoxMinor: 3600, totalMinor: 108000, needsDecision: true, readable: true });
    expect(h.conditions).toEqual([{ code: "UNSUPPORTED_CUSTOMIZATION", text: "Gold foil lid." }]);
    expect(mine.find((d) => d.quoteId === cleanQuote)).toMatchObject({ boxCount: 20, totalMinor: 72000, needsDecision: false });
  });

  it("does not list published, withdrawn or superseded quotes", async () => {
    const inquiryId = await newInquiry();
    const toPublish = await draft(inquiryId);
    await publishQuote(db, toPublish, system, ctx);
    const toWithdraw = await draft(inquiryId, 31, [{ code: "UNSUPPORTED_CUSTOMIZATION", text: "x" }]);
    await withdrawQuote(db, toWithdraw, { kind: "merchant", userId: randomUUID(), merchantId: MERCHANT_ID }, "No.", ctx);

    const ids = (await listReviewDrafts(db, MERCHANT_ID)).map((d) => d.quoteId);
    expect(ids).not.toContain(toPublish);
    expect(ids).not.toContain(toWithdraw);
  });

  it("returns only the named merchant's drafts", async () => {
    const other = must(await db.from("merchants").insert({ slug: unique("rq"), name: "Other merchant" }).select("id").single()).id as string;
    const theirInquiry = await newInquiry(other);
    // The other merchant has no catalog, so write a draft row directly.
    const theirs = must(
      await db
        .from("quote_versions")
        .insert({ inquiry_id: theirInquiry, version: 1, lines: { boxCount: 1, perBoxMinor: 1, lines: [{ slotId: "a", sku: "X", name: "X", unitPriceMinor: 1, quantity: 1 }] }, total_minor: 1 })
        .select("id")
        .single(),
    ).id as string;

    expect((await listReviewDrafts(db, MERCHANT_ID)).map((d) => d.quoteId)).not.toContain(theirs);
    expect((await listReviewDrafts(db, other)).map((d) => d.quoteId)).toEqual([theirs]);
  });

  it("marks a draft whose stored lines do not fit as unreadable instead of failing", async () => {
    const inquiryId = await newInquiry();
    const bad = must(
      await db.from("quote_versions").insert({ inquiry_id: inquiryId, version: 1, lines: { nonsense: true }, total_minor: 5 }).select("id").single(),
    ).id as string;
    const found = (await listReviewDrafts(db, MERCHANT_ID)).find((d) => d.quoteId === bad);
    expect(found).toMatchObject({ readable: false, boxCount: null, perBoxMinor: null, totalMinor: 5 });
  });

  it("through a signed-in merchant's own session, row level security shows only their own drafts", async () => {
    const owner = await createMerchantUser(db);
    const mine = must(await db.from("merchants").insert({ slug: unique("rls"), name: "RLS merchant", owner_user_id: owner.id }).select("id").single()).id as string;
    const myInquiry = await newInquiry(mine);
    const myDraft = must(
      await db
        .from("quote_versions")
        .insert({ inquiry_id: myInquiry, version: 1, lines: { boxCount: 1, perBoxMinor: 1, lines: [{ slotId: "a", sku: "X", name: "X", unitPriceMinor: 1, quantity: 1 }] }, total_minor: 1 })
        .select("id")
        .single(),
    ).id as string;
    const demoDraft = await draft(await newInquiry());

    const session = await signedInClient(owner.email, owner.password);
    expect((await listReviewDrafts(session, mine)).map((d) => d.quoteId)).toEqual([myDraft]);
    // Even if the wrong merchant id is asked for, the other merchant's rows stay invisible.
    expect((await listReviewDrafts(session, MERCHANT_ID)).map((d) => d.quoteId)).not.toContain(demoDraft);
  });
});
