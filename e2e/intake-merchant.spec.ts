// The merchant's side of a handed-over inquiry, in a real browser against the LOCAL Supabase stack, with the rule-based stand-in
// model on the server (never a real model).
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { adminClient, createSeller, needsLocalSupabase, signIn, type Seller } from "./payments-support";

test("the inquiries page is merchant-only: a visitor with no session is sent to the login page", async ({ page }) => {
  await page.goto("/merchant/inquiries");
  await expect(page).toHaveURL(/\/merchant\/login$/);
});

test.describe("handed-over inquiries (local Supabase, stand-in model)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  let a: Seller;
  let b: Seller;
  let slugA: string;

  test.beforeAll(async () => {
    db = adminClient();
    a = await createSeller(db, "ia");
    b = await createSeller(db, "ib");
    const row = await db.from("merchants").select("slug").eq("id", a.merchantId).single();
    slugA = row.data!.slug as string;
  });

  async function asNewVisitor(page: Page) {
    const n = Math.floor(Math.random() * 250) + 1;
    await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${n}, 203.0.113.${n}` });
  }

  /** The customer describes an order on the store page, then asks the merchant to take over. */
  async function customerHandsOver(page: Page, message: string) {
    await asNewVisitor(page);
    await page.goto(`/store/${slugA}`);
    await page.getByLabel("Describe the custom order you have in mind").fill(message);
    await page.getByRole("button", { name: "Start my request" }).click();
    await page.waitForURL(/\/o\//);
    await page.getByRole("button", { name: "Ask the merchant to take over" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "The merchant has your request" })).toBeVisible();
  }

  const card = (page: Page, text: string) => page.getByRole("article", { name: /^Inquiry / }).filter({ hasText: text });

  test("the merchant sees the conversation and specification, replies, and the customer reads the reply", async ({ page, browser }) => {
    const text = `30 boxes, no food, our logo, ref ${Date.now()}`;
    const customer = await (await browser.newContext()).newPage();
    await customerHandsOver(customer, text);

    await signIn(page, a);
    await page.getByRole("link", { name: "Inquiries" }).click();
    await expect(page).toHaveURL(/\/merchant\/inquiries$/);
    const mine = card(page, text);
    await expect(mine).toHaveCount(1);
    await expect(mine).toContainText("Number of boxes");
    await expect(mine).toContainText("30 (confirmed)");
    await expect(mine).toContainText("No food");
    await expect(mine.getByRole("listitem").filter({ hasText: text })).toHaveCount(1);
    await expect(mine).toContainText("You asked the merchant to take over");

    await mine.getByLabel("Reply to the customer").fill("Happy to help. Which logo file will you send?");
    await mine.getByRole("button", { name: "Send reply" }).click();
    await expect(mine.getByRole("listitem").filter({ hasText: "Which logo file will you send?" })).toBeVisible();

    await customer.reload();
    await expect(customer.getByText("Which logo file will you send?")).toBeVisible();
    await expect(customer.getByText(/^merchant ·/)).toBeVisible();
  });

  test("an inquiry handed over after a failure has nothing recorded, and the page says so", async ({ page, browser }) => {
    const text = `[[outage]] 12 boxes ${Date.now()}`;
    const customer = await (await browser.newContext()).newPage();
    await asNewVisitor(customer);
    await customer.goto(`/store/${slugA}`);
    await customer.getByLabel("Describe the custom order you have in mind").fill(text);
    await customer.getByRole("button", { name: "Start my request" }).click();
    await customer.waitForURL(/\/o\//);
    await customer.getByRole("button", { name: "Ask the merchant to take over" }).first().click();
    await expect(customer.getByRole("status").filter({ hasText: "The merchant has your request" })).toBeVisible();

    await signIn(page, a);
    await page.goto("/merchant/inquiries");
    const mine = card(page, text);
    await expect(mine).toContainText("Nothing was recorded before the handover");
    await expect(mine).toContainText(text);
  });

  test("another merchant sees none of it", async ({ page, browser }) => {
    const text = `private to merchant A ${Date.now()}`;
    const customer = await (await browser.newContext()).newPage();
    await customerHandsOver(customer, text);

    await signIn(page, b);
    await page.goto("/merchant/inquiries");
    await expect(page.getByRole("heading", { name: "Inquiries" })).toBeVisible();
    await expect(page.getByText(text)).toHaveCount(0);
    await expect(page.getByText("No inquiries are waiting for you.")).toBeVisible();
  });
});
