// Real local Postgres; purchases go through the LOCAL FAKE PayPal (mocked evidence). Two shops, two owners, both with real orders:
// one shop's owner can neither read nor change anything of the other shop's, by any shop-side entry point, and an owner session
// that asks for the other shop's id gets nothing. Row level security is tested table by table in rls.test.ts; this file tests the
// services and the reads the shop pages actually call.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addProduct, editProduct } from "@/services/catalog/edit";
import { loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { createJobForPurchase } from "@/services/fulfillment/create";
import { moveJob } from "@/services/fulfillment/move";
import { listJobsForMerchant, readJob } from "@/services/fulfillment/read";
import { buildQuoteForInquiry, quoteBuilderView } from "@/services/intake/merchant-quote";
import { replyAsMerchant } from "@/services/intake/merchant";
import { listInquiriesForMerchant } from "@/services/intake/read";
import { merchantOverview } from "@/services/merchant/overview";
import { decide } from "@/services/payments/decide";
import { listDecisionsForMerchant } from "@/services/payments/read";
import { listReviewDrafts } from "@/services/quote/review-queue";
import { listHoldsForMerchant } from "@/services/reservation/read";
import { startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { createMerchantUser, must, serviceClient, signedInClient } from "./helpers";
import { T0 } from "./fulfillment-helpers";
import { paypalFor, takeTo, type Paid } from "./fulfillment-paid";
import { expectStockConsistentAtEnd } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

let fake: FakePayPal;
const ctx = { now: T0, correlationId: "corr-shop-isolation" };

type Shop = {
  merchantId: string;
  session: SupabaseClient;
  actor: { kind: "merchant"; userId: string; merchantId: string };
  waiting: Paid[]; // authorized, waiting for the shop's OK
  paid: Paid; // captured, with a preparation job
  jobId: string;
  reviewInquiry: string; // a request handed to the shop
  productId: string;
};

/** A shop with its own owner, `waitingCount` orders waiting for the shop's OK, one paid order with a job, and one request handed over. */
async function makeShop(waitingCount: number): Promise<Shop> {
  const user = await createMerchantUser(db);
  const session = await signedInClient(user.email, user.password);
  const first = await takeTo(db, fake, "captured");
  const merchantId = first.m.merchantId;
  must(await db.from("merchants").update({ owner_user_id: user.id }).eq("id", merchantId));
  const made = await createJobForPurchase(db, first.purchaseId, ctx);
  if (!made.ok) throw new Error(`createJob: ${made.code}`);

  const waiting: Paid[] = [];
  for (let i = 0; i < waitingCount; i++) waiting.push(await takeTo(db, fake, "authorized", { merchant: first.m }));

  const inquiry = must(await db.from("inquiries").insert({ merchant_id: merchantId, status: "REVIEW_REQUIRED" }).select("id").single(), "review inquiry");
  must(await db.from("messages").insert({ inquiry_id: inquiry.id, role: "customer", body: "Please make 30 boxes for our team." }));
  return {
    merchantId,
    session,
    actor: { kind: "merchant", userId: user.id, merchantId },
    waiting,
    paid: first,
    jobId: made.value.jobId,
    reviewInquiry: inquiry.id as string,
    productId: first.m.product["PEN-BLK"]!,
  };
}

let A: Shop;
let B: Shop;

beforeAll(async () => {
  fake = await startFakePayPal();
  A = await makeShop(1);
  B = await makeShop(2); // different counts, so a leak between the shops would change a number
});
afterAll(async () => {
  await fake.close();
});

const jobIds = (rows: Array<{ jobId: string }>) => rows.map((r) => r.jobId);
const purchaseIdsOf = (rows: Array<{ purchaseId: string }>) => rows.map((r) => r.purchaseId);

describe("an owner's own session sees their own shop's work and nothing of the other shop's", () => {
  it("jobs", async () => {
    expect(jobIds(await listJobsForMerchant(A.session, A.merchantId))).toEqual([A.jobId]);
    expect(jobIds(await listJobsForMerchant(B.session, B.merchantId))).toEqual([B.jobId]);
    expect(await readJob(A.session, A.merchantId, A.jobId)).not.toBeNull();
  });

  it("orders waiting for the shop's OK", async () => {
    const a = purchaseIdsOf(await listDecisionsForMerchant(A.session, A.merchantId, T0));
    const b = purchaseIdsOf(await listDecisionsForMerchant(B.session, B.merchantId, T0));
    for (const w of A.waiting) expect(a).toContain(w.purchaseId);
    for (const w of B.waiting) expect(b).toContain(w.purchaseId);
    for (const w of B.waiting) expect(a).not.toContain(w.purchaseId);
    for (const w of A.waiting) expect(b).not.toContain(w.purchaseId);
  });

  it("requests handed to the shop", async () => {
    expect((await listInquiriesForMerchant(A.session, A.merchantId)).map((i) => i.inquiryId)).toEqual([A.reviewInquiry]);
    expect((await listInquiriesForMerchant(B.session, B.merchantId)).map((i) => i.inquiryId)).toEqual([B.reviewInquiry]);
  });

  it("the counts on Today are the shop's own (A: 1 request, 1 waiting, 1 to prepare; B: 1, 2, 1)", async () => {
    expect(await merchantOverview(A.session, A.merchantId, T0)).toEqual({ requestsToAnswer: 1, paymentsToDecide: 1, ordersToPrepare: 1 });
    expect(await merchantOverview(B.session, B.merchantId, T0)).toEqual({ requestsToAnswer: 1, paymentsToDecide: 2, ordersToPrepare: 1 });
  });

  it("stock holds", async () => {
    const holdsA = await listHoldsForMerchant(A.session, A.merchantId);
    const holdsB = await listHoldsForMerchant(B.session, B.merchantId);
    expect(holdsA.length).toBeGreaterThan(0);
    expect(holdsB.length).toBeGreaterThan(holdsA.length); // B has more orders, so more holds
    const idsA = new Set(holdsA.map((h) => JSON.stringify(h)));
    expect(holdsB.some((h) => idsA.has(JSON.stringify(h)))).toBe(false);
  });

  it("the catalog, from each owner's session, holds only their own products", async () => {
    const a = await loadCatalogSnapshot(A.session, A.merchantId);
    const b = await loadCatalogSnapshot(B.session, B.merchantId);
    const idsA = new Set(a.catalog.products.map((p) => p.id));
    expect(b.catalog.products.some((p) => idsA.has(p.id))).toBe(false);
    expect(a.catalog.products.length).toBeGreaterThan(0);
  });
});

describe("asking for the other shop's id from your own session gets nothing", () => {
  it("jobs, orders, requests, holds and quotes to review are empty", async () => {
    expect(await listJobsForMerchant(A.session, B.merchantId)).toEqual([]);
    expect(await readJob(A.session, B.merchantId, B.jobId)).toBeNull();
    expect(await listDecisionsForMerchant(A.session, B.merchantId, T0)).toEqual([]);
    expect(await listInquiriesForMerchant(A.session, B.merchantId)).toEqual([]);
    expect(await listHoldsForMerchant(A.session, B.merchantId)).toEqual([]);
    expect(await listReviewDrafts(A.session, B.merchantId)).toEqual([]);
    expect(await merchantOverview(A.session, B.merchantId, T0)).toEqual({ requestsToAnswer: 0, paymentsToDecide: 0, ordersToPrepare: 0 });
  });

  it("the catalog is not readable (the other shop's rules are invisible), so nothing of theirs is returned", async () => {
    const outcome = await loadCatalogSnapshot(A.session, B.merchantId).then(
      (s) => s.catalog.products.map((p) => p.id),
      () => "refused",
    );
    if (outcome !== "refused") expect(outcome).toEqual([]);
  });

  it("the other shop's request cannot be opened in the quote builder", async () => {
    expect(await quoteBuilderView(A.session, B.merchantId, B.reviewInquiry)).toBeNull();
    expect(await quoteBuilderView(A.session, A.merchantId, B.reviewInquiry)).toBeNull();
  });
});

describe("a shop cannot change the other shop's data through any shop-side service", () => {
  it("deciding another shop's waiting order is NOT_FOUND and sends nothing to PayPal", async () => {
    const target = B.waiting[0]!;
    const deps = { paypal: paypalFor(fake), evidence: "mocked" as const };
    const before = fake.requests.length;
    expect(await decide(db, deps, A.actor, target.purchaseId, "accepted", { confirmedConditions: [] }, ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await decide(db, deps, A.actor, target.purchaseId, "declined", { reason: "No." }, ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(fake.requests.length).toBe(before); // nothing was sent to PayPal
    const attempt = must(await db.from("payment_attempts").select("state").eq("purchase_id", target.purchaseId).single());
    expect(attempt.state).toBe("AUTHORIZED");
    expect(must(await db.from("merchant_decisions").select("decision").eq("purchase_id", target.purchaseId).single()).decision).toBe("pending");
  });

  it("moving another shop's job is NOT_FOUND and the job stays where it was", async () => {
    expect(await moveJob(db, A.actor, B.jobId, "PREPARING", {}, ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(must(await db.from("preparation_jobs").select("status").eq("id", B.jobId).single()).status).toBe("QUEUED");
  });

  it("editing another shop's product is NOT_FOUND and the product is unchanged", async () => {
    const before = must(await db.from("products").select("name, unit_price_minor").eq("id", B.productId).single());
    expect(await editProduct(db, A.actor, B.productId, { name: "Hijacked", priceMinor: 1 }, ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(must(await db.from("products").select("name, unit_price_minor").eq("id", B.productId).single())).toEqual(before);
  });

  it("a product the shop adds belongs to that shop only, and never appears in the other's catalog", async () => {
    const countB = must(await db.from("products").select("id").eq("merchant_id", B.merchantId)).length;
    const added = await addProduct(db, A.actor, { sku: "ISO-ONLY-A", name: "Only A sells this", category: "misc", priceMinor: 500, isFood: false, onHand: 5, slotIds: ["gift"] }, ctx);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(must(await db.from("products").select("merchant_id").eq("id", added.value.productId).single()).merchant_id).toBe(A.merchantId);
    expect(must(await db.from("products").select("id").eq("merchant_id", B.merchantId))).toHaveLength(countB);
    const snapshotB = await loadCatalogSnapshot(db, B.merchantId);
    expect(snapshotB.catalog.products.some((p) => p.sku === "ISO-ONLY-A")).toBe(false);
  });

  it("replying to another shop's request is refused and adds no message", async () => {
    const before = must(await db.from("messages").select("id").eq("inquiry_id", B.reviewInquiry)).length;
    expect(await replyAsMerchant(db, A.actor, B.reviewInquiry, "We can do it.", ctx)).toMatchObject({ ok: false, code: "INQUIRY_NOT_FOUND" });
    expect(must(await db.from("messages").select("id").eq("inquiry_id", B.reviewInquiry))).toHaveLength(before);
  });

  it("building a price for another shop's request is NOT_FOUND, creates no quote and leaves the request with its shop", async () => {
    const input = {
      quantity: 30,
      selections: { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "ORGANIZER-DESK", card: "CARD-BRANDED", packaging: "PACK-BOX" },
      notes: { artwork: false, productionSlot: false },
    };
    const quotesBefore = must(await db.from("quote_versions").select("id").eq("inquiry_id", B.reviewInquiry)).length;
    expect(await buildQuoteForInquiry(db, A.actor, B.reviewInquiry, input, ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(must(await db.from("quote_versions").select("id").eq("inquiry_id", B.reviewInquiry))).toHaveLength(quotesBefore);
    expect(must(await db.from("inquiries").select("status").eq("id", B.reviewInquiry).single()).status).toBe("REVIEW_REQUIRED");
  });

  it("the other shop's own actions still work afterwards (nothing above locked or changed it)", async () => {
    const moved = await moveJob(db, B.actor, B.jobId, "PREPARING", {}, ctx);
    expect(moved.ok).toBe(true);
  });
});
