import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { eventCount, jobOf, makeJob, paidPurchase } from "./fulfillment-support";
import { adminClient, authorizedPurchase, createSeller, needsLocalSupabase, signIn, type Seller } from "./payments-support";

test("the jobs page is merchant-only: a visitor with no session is sent to the login page", async ({ page }) => {
  await page.goto("/merchant/jobs");
  await expect(page).toHaveURL(/\/merchant\/login$/);
});

test.describe("preparing paid orders (local Supabase + fake PayPal, mocked evidence)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  let a: Seller;
  let b: Seller;
  test.beforeAll(async () => {
    db = adminClient();
    a = await createSeller(db, "fa");
    b = await createSeller(db, "fb");
  });

  const cardFor = (page: Page, inquiryId: string) => page.getByRole("article", { name: new RegExp(`Job for request ${inquiryId.slice(0, 8)}`) });

  test("accepting a payment makes the job, with its worksheet, and the merchant moves it to collected", async ({ page, browser }) => {
    const p = await authorizedPurchase(db, a, [{ code: "PRODUCTION_SLOT_CONFIRMATION", text: "Production slot to be confirmed." }]);
    await signIn(page, a);

    // The accept action itself asks for the job.
    await page.goto("/merchant/decisions");
    const order = page.getByRole("article", { name: new RegExp(p.inquiryId.slice(0, 8)) });
    await order.getByLabel("Production slot to be confirmed.").check();
    await order.getByRole("button", { name: /Accept/ }).click();
    await expect.poll(async () => (await jobOf(db, p.purchaseId))?.status, { timeout: 15_000 }).toBe("QUEUED");

    await page.getByRole("link", { name: "Back" }).click();
    await page.getByRole("link", { name: "Prepare orders" }).click();
    await expect(page).toHaveURL(/\/merchant\/jobs$/);
    const card = cardFor(page, p.inquiryId);
    await expect(card).toContainText("30 boxes");
    await expect(card).toContainText("Status: Queued");
    await expect(card).toContainText("Paid $1,080.00");
    await expect(card).toContainText("30 × Desk organizer (ORGANIZER-DESK)");
    await expect(card).toContainText("30 × A5 notebook (NOTEBOOK-A5)");
    await expect(card).toContainText("Production slot to be confirmed. (you confirmed this)");
    await expect(card).toContainText(/Ready by \d{4}-\d{2}-\d{2}/);

    // The customer follows along.
    const customer = await (await browser.newContext()).newPage();
    await customer.goto(`/o/${p.link}`);
    await expect(customer.getByRole("region", { name: "Your order" })).toContainText("The shop is getting your order ready");

    await card.getByRole("button", { name: "Start preparing" }).click();
    await expect(card).toContainText("Status: Preparing");
    await card.getByRole("button", { name: "Mark ready for pickup" }).click();
    await expect(card).toContainText("Status: Ready for pickup");
    await customer.reload();
    await expect(customer.getByRole("region", { name: "Your order" })).toContainText("ready for pickup");

    await card.getByRole("button", { name: "Record pickup" }).click();
    await expect(page.getByRole("region", { name: "Collected" })).toContainText(`Request ${p.inquiryId.slice(0, 8)}`);
    await customer.reload();
    await expect(customer.getByRole("region", { name: "Your order" })).toContainText("collected");
    await expect(cardFor(page, p.inquiryId).getByRole("button")).toHaveCount(0);
    expect((await jobOf(db, p.purchaseId))?.status).toBe("COLLECTED");
  });

  test("a double click moves the job once", async ({ page }) => {
    const p = await paidPurchase(db, a);
    const jobId = await makeJob(db, p.purchaseId);
    await signIn(page, a);
    await page.goto("/merchant/jobs");
    await cardFor(page, p.inquiryId).getByRole("button", { name: "Start preparing" }).dblclick();
    await expect.poll(async () => (await jobOf(db, p.purchaseId))?.status, { timeout: 15_000 }).toBe("PREPARING");
    expect(await eventCount(db, jobId)).toBe(2);
  });

  test("a hold needs a note; the customer sees only that it is delayed; resume goes back where it was", async ({ page, browser }) => {
    const p = await paidPurchase(db, a);
    await makeJob(db, p.purchaseId);
    await signIn(page, a);
    await page.goto("/merchant/jobs");
    const card = cardFor(page, p.inquiryId);
    await card.getByRole("button", { name: "Start preparing" }).click();
    await expect(card).toContainText("Status: Preparing");

    await card.getByRole("button", { name: "Put on hold" }).click();
    await expect(card.getByRole("alert")).toContainText("Write a note for the hold");
    expect((await jobOf(db, p.purchaseId))?.status).toBe("PREPARING");

    await card.getByLabel(/Note/).fill("Ribbon is late, internal detail.");
    await card.getByRole("button", { name: "Put on hold" }).click();
    await expect(card).toContainText("Status: On hold");
    await expect(card).toContainText("Ribbon is late, internal detail.");

    const customer = await (await browser.newContext()).newPage();
    await customer.goto(`/o/${p.link}`);
    const view = customer.getByRole("region", { name: "Your order" });
    await expect(view).toContainText("taking longer than planned");
    await expect(view).not.toContainText("Ribbon");
    await expect(customer.getByText("Ribbon")).toHaveCount(0);

    await expect(card.getByRole("button", { name: "Resume (back to preparing)" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Mark ready for pickup" })).toHaveCount(0);
    await card.getByRole("button", { name: "Resume (back to preparing)" }).click();
    await expect(card).toContainText("Status: Preparing");
  });

  test("a merchant sees only their own jobs", async ({ page }) => {
    const mine = await paidPurchase(db, a);
    const theirs = await paidPurchase(db, b);
    await makeJob(db, mine.purchaseId);
    await makeJob(db, theirs.purchaseId);
    await signIn(page, a);
    await page.goto("/merchant/jobs");
    await expect(cardFor(page, mine.inquiryId)).toBeVisible();
    await expect(cardFor(page, theirs.inquiryId)).toHaveCount(0);
  });

  test("an empty list says so", async ({ page }) => {
    const c = await createSeller(db, "fc");
    await signIn(page, c);
    await page.goto("/merchant/jobs");
    await expect(page.getByRole("region", { name: "To prepare" })).toContainText("No jobs are waiting.");
    await expect(page.getByRole("region", { name: "Collected" })).toContainText("Nothing has been collected yet.");
  });
});
