// The order room at every stage of an order, in a real browser against the LOCAL Supabase stack, with the stand-in model and the local
// fake PayPal (mocked). At each stage the progress strip and the headline are the right ones, and no raw state name, SKU or id is
// on the page. The header's own words are also checked against the whole customer vocabulary list; the quote and payment sections
// join that check when their wording is rewritten (task T4).
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { forbiddenIn, WORDS, STEP_LABELS } from "../domain/journey";
import { createCustomerLink } from "../lib/access/customer-link";
import { decide } from "../services/payments/decide";
import { moveJob } from "../services/fulfillment/move";
import { createQuoteDraft } from "../services/quote/create-draft";
import { publishQuote } from "../services/quote/publish";
import { products } from "../supabase/seed/fixtures";
import { actorOf, jobOf, makeJob, paidPurchase } from "./fulfillment-support";
import { acceptedPurchase, adminClient, authorizedPurchase, createSeller, needsLocalSupabase, paymentDeps, type Seller } from "./payments-support";

const RAW_STATES = [
  "NEW", "CLARIFYING", "CONFIGURING", "QUOTE_READY", "REVIEW_REQUIRED",
  "PUBLISHED", "ACCEPTED", "NONE", "PAYING", "WAITING_MERCHANT", "CHECKING", "PAID", "DECLINED", "FAILED",
  "QUEUED", "PREPARING", "READY_FOR_PICKUP", "COLLECTED", "ON_HOLD", "AUTHORIZED", "CAPTURED", "COMMITTED",
];
const SKUS = products.map((p) => p.sku);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test.describe("the order room at every stage (local Supabase, stand-in model, fake PayPal)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  let seller: Seller;
  let slug: string;

  test.beforeAll(async () => {
    db = adminClient();
    seller = await createSeller(db, "words");
    slug = (await db.from("merchants").select("slug").eq("id", seller.merchantId).single()).data!.slug as string;
  });

  async function asNewVisitor(page: Page) {
    const a = Math.floor(Math.random() * 250) + 1;
    const b = Math.floor(Math.random() * 250) + 1;
    await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `100.64.${a}.${b}` });
  }

  // Every test visits the order room from a private address, so this spec never uses up the shared per-address budget of the others.
  test.beforeEach(async ({ page }) => {
    await asNewVisitor(page);
  });

  async function startRequest(page: Page, message: string) {
    await asNewVisitor(page);
    await page.goto(`/store/${slug}`);
    await page.getByLabel("Describe the custom order you have in mind").fill(message);
    await page.getByRole("button", { name: "Start my request" }).click();
    await page.waitForURL(/\/o\//);
    await expect(page.getByRole("heading", { name: "Your request", exact: true })).toBeVisible();
  }

  /** The strip names the step the customer is on, and the headline is the one for this stage. */
  async function expectStage(page: Page, words: keyof typeof WORDS, stepLabel: string | null) {
    await expect(page.getByRole("heading", { name: WORDS[words].headline, level: 2 })).toBeVisible();
    await expect(page.getByText(WORDS[words].detail)).toBeVisible();
    const strip = page.getByRole("list", { name: "Your progress" });
    await expect(strip.getByRole("listitem")).toHaveCount(STEP_LABELS.length);
    if (stepLabel === null) {
      await expect(strip.locator("[aria-current=step]")).toHaveCount(0); // everything is done
    } else {
      await expect(strip.locator("[aria-current=step]")).toHaveCount(1);
      await expect(strip.locator("[aria-current=step]")).toContainText(stepLabel);
    }
  }

  /** No raw state name, SKU or id anywhere on the page; the header's words pass the whole vocabulary list. */
  async function scan(page: Page, where: string) {
    const text = await page.getByRole("main").innerText();
    for (const state of RAW_STATES) expect(text, `${where}: ${state}`).not.toMatch(new RegExp(`\\b${state}\\b`));
    for (const sku of SKUS) expect(text, `${where}: ${sku}`).not.toContain(sku);
    expect(text, `${where}: an id`).not.toMatch(UUID);
    expect(text, `${where}: a status line`).not.toMatch(/Status:/);
    const header = await page.getByTestId("order-header").innerText();
    expect(forbiddenIn(header), `${where}: header words`).toEqual([]);
    // The order so far, the open question, the boxes and the writing box use the customer's vocabulary too (the conversation's own
    // messages, the price and the payment sections join this check in T4).
    for (const region of ["Your order so far", "Open question", "Proposals"]) {
      const found = page.getByRole("region", { name: region });
      if ((await found.count()) > 0) expect(forbiddenIn(await found.innerText()), `${where}: ${region}`).toEqual([]);
    }
    const form = page.getByRole("form", { name: "New message" });
    if ((await form.count()) > 0) expect(forbiddenIn(await form.innerText()), `${where}: message form`).toEqual([]);
  }

  const customerLink = (inquiryId: string) =>
    createCustomerLink({ inquiryId, version: 1, expiresAt: new Date(Date.now() + 3_600_000), secret: process.env.E2E_ACCESS_LINK_SECRET! });

  test("while describing: a stalled assistant, an open question, boxes to choose, handed to the shop", async ({ page }) => {
    await startRequest(page, "[[outage]] 20 boxes, no food");
    await expectStage(page, "stalled", "Describe");
    await scan(page, "stalled");

    await startRequest(page, "No food, our logo, under $40 per box");
    await expectStage(page, "needAnswer", "Describe");
    await scan(page, "question open");

    await startRequest(page, "20 boxes, no food");
    await expectStage(page, "choose", "Choose");
    await scan(page, "boxes shown");

    await page.getByRole("button", { name: "Ask the shop to take over" }).first().click();
    await expectStage(page, "withShop", "Choose");
    await scan(page, "with the shop");
  });

  async function publishedFor(now = new Date().toISOString()): Promise<string> {
    const inquiry = await db.from("inquiries").insert({ merchant_id: seller.merchantId }).select("id").single();
    if (inquiry.error) throw new Error(inquiry.error.message);
    const inquiryId = inquiry.data.id as string;
    const ctx = { now, correlationId: `e2e-words-${randomBytes(3).toString("hex")}` };
    const draft = await createQuoteDraft(
      db,
      {
        inquiryId,
        configuration: { boxCount: 30, selections: { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "ORGANIZER-DESK", card: "CARD-BRANDED", packaging: "PACK-BOX" } },
        requirements: { noFood: true, logoRequired: true, maxPricePerBoxMinor: 3999 },
        requirementVersionId: null,
        conditions: [],
      },
      ctx,
    );
    if (!draft.ok) throw new Error(`draft: ${draft.code}`);
    const published = await publishQuote(db, draft.value.quoteId, { kind: "system" }, ctx);
    if (!published.ok) throw new Error(`publish: ${published.code}`);
    return customerLink(inquiryId);
  }

  test("a price to review, and a price that has expired", async ({ page }) => {
    await page.goto(`/o/${await publishedFor()}`);
    await expectStage(page, "reviewPrice", "Review price");
    await scan(page, "price to review");

    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await page.goto(`/o/${await publishedFor(fiveDaysAgo)}`);
    await expectStage(page, "priceExpired", "Review price");
    await expect(page.getByRole("list", { name: "Your progress" }).locator("[data-state=stopped]")).toHaveCount(1);
    await scan(page, "price expired");
  });

  test("accepted, waiting for the shop, and declined", async ({ page }) => {
    const accepted = await acceptedPurchase(db, seller);
    await page.goto(`/o/${accepted.link}`);
    await expectStage(page, "approve", "Approve");
    await scan(page, "accepted");

    const waiting = await authorizedPurchase(db, seller);
    await page.goto(`/o/${waiting.link}`);
    await expectStage(page, "waitingShop", "Shop confirms");
    await scan(page, "waiting for the shop");

    const declined = await authorizedPurchase(db, seller);
    const done = await decide(db, paymentDeps(), actorOf(seller), declined.purchaseId, "declined", { reason: "Out of stock" }, { now: new Date().toISOString(), correlationId: "e2e-words" });
    if (!done.ok) throw new Error(`decide: ${done.code}`);
    await page.goto(`/o/${declined.link}`);
    await expectStage(page, "declined", "Shop confirms");
    await expect(page.getByRole("list", { name: "Your progress" }).locator("[data-state=stopped]")).toHaveCount(1);
    await scan(page, "declined");
  });

  test("paid: being prepared, ready for pickup, collected", async ({ page }) => {
    const paid = await paidPurchase(db, seller);
    const jobId = await makeJob(db, paid.purchaseId);
    const ctx = () => ({ now: new Date().toISOString(), correlationId: "e2e-words" });

    await page.goto(`/o/${paid.link}`);
    await expectStage(page, "preparing", "Pick up");
    await scan(page, "being prepared");

    const move = async (to: "PREPARING" | "READY_FOR_PICKUP" | "COLLECTED") => {
      const out = await moveJob(db, actorOf(seller), jobId, to, {}, ctx());
      if (!out.ok) throw new Error(`move ${to}: ${out.code}`);
    };
    await move("PREPARING");
    await move("READY_FOR_PICKUP");
    await page.reload();
    await expectStage(page, "ready", "Pick up");
    await scan(page, "ready for pickup");

    await move("COLLECTED");
    await page.reload();
    await expectStage(page, "collected", null);
    await scan(page, "collected");
    expect((await jobOf(db, paid.purchaseId))?.status).toBe("COLLECTED");
  });
});
