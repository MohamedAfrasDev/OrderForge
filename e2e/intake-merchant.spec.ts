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
    // A range no other spec uses (access.spec exhausts 198.51.100.77, .78 and .88 on purpose).
    const a = Math.floor(Math.random() * 250) + 1;
    const b = Math.floor(Math.random() * 250) + 1;
    await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `100.64.${a}.${b}` });
  }

  /** The customer describes an order on the store page, then asks the shop to take over. */
  async function customerHandsOver(page: Page, message: string) {
    await asNewVisitor(page);
    await page.goto(`/store/${slugA}`);
    await page.getByLabel("Describe the custom order you have in mind").fill(message);
    await page.getByRole("button", { name: "Start my request" }).click();
    await page.waitForURL(/\/o\//);
    await page.getByRole("button", { name: "Ask the shop to take over" }).first().click();
    await expect(page.getByRole("heading", { name: "With the shop", level: 2 })).toBeVisible();
  }

  /** Chooses the request's row in the Requests grid and returns its detail article. */
  async function openRequest(page: Page, text: string) {
    const grid = page.getByRole("grid", { name: "Requests" });
    await page.getByLabel("Search requests").fill(text);
    await grid.getByRole("row").filter({ hasText: text }).first().click();
    return page.getByRole("article", { name: /^Inquiry / }).filter({ hasText: text });
  }

  test("the merchant sees the conversation and specification, replies, and the customer reads the reply", async ({ page, browser }) => {
    const text = `30 boxes, no food, our logo, ref ${Date.now()}`;
    const customer = await (await browser.newContext()).newPage();
    await customerHandsOver(customer, text);

    await signIn(page, a);
    // Today says a request waits, and its one button leads to the Requests grid.
    const today = page.getByTestId("today-requests");
    await expect(today).toContainText("1 request needs your answer");
    await expect(today).toHaveAttribute("data-count", "1");
    await page.getByRole("link", { name: "Open requests" }).click();
    await expect(page).toHaveURL(/\/merchant\/inquiries$/);
    const mine = await openRequest(page, text);
    await expect(mine).toHaveCount(1);
    await expect(mine).toContainText("Number of boxes");
    await expect(mine).toContainText("30 (confirmed)");
    await expect(mine).toContainText("No food");
    await expect(mine.getByRole("listitem").filter({ hasText: text })).toHaveCount(1);
    await expect(mine).toContainText("You asked the shop to take over");

    await mine.getByLabel("Reply to the customer").fill("Happy to help. Which logo file will you send?");
    await mine.getByRole("button", { name: "Send reply" }).click();
    await expect(mine.getByRole("listitem").filter({ hasText: "Which logo file will you send?" })).toBeVisible();

    await customer.reload();
    await expect(customer.getByText("Which logo file will you send?")).toBeVisible();
    // The reply is signed with the shop's name, not with a role.
    await expect(customer.getByRole("article").filter({ hasText: "Which logo file will you send?" })).toContainText(/E2E Pay ia/);
  });

  test("three starting phrases fill the reply box; nothing is sent until the shop sends it, and the shop can change the words", async ({ page, browser }) => {
    const text = `phrases test ${Date.now()}`;
    const customer = await (await browser.newContext()).newPage();
    await customerHandsOver(customer, text);

    await signIn(page, a);
    await page.goto("/merchant/inquiries");
    const mine = await openRequest(page, text);
    const box = mine.getByLabel("Reply to the customer");
    const phrases = mine.getByRole("group", { name: "Starting phrases" }).getByRole("button");
    await expect(phrases).toHaveCount(3);
    const before = await mine.getByRole("listitem").count();

    await mine.getByRole("button", { name: "Ask for number and date" }).click();
    await expect(box).toHaveValue("Could you tell me how many boxes you need, and by when?");
    await mine.getByRole("button", { name: "Thanks, looking now" }).click(); // a second phrase is added after the first, not over it
    await expect(box).toHaveValue("Could you tell me how many boxes you need, and by when?\nThanks for your request. I'm looking at it now.");
    expect(await mine.getByRole("listitem").count()).toBe(before); // nothing sent yet
    await customer.reload();
    await expect(customer.getByText("how many boxes you need, and by when")).toHaveCount(0);

    await box.fill("Yes, we can do that. Which logo file will you send?"); // the words can be changed
    await mine.getByRole("button", { name: "Send reply" }).click();
    await expect(mine.getByRole("listitem").filter({ hasText: "Which logo file will you send?" })).toBeVisible();
    await expect(box).toHaveValue(""); // the next reply starts empty
    await customer.reload();
    await expect(customer.getByText("Which logo file will you send?")).toBeVisible();
  });

  test("an inquiry handed over after a failure has nothing recorded, and the page says so", async ({ page, browser }) => {
    const text = `[[outage]] 12 boxes ${Date.now()}`;
    const customer = await (await browser.newContext()).newPage();
    await asNewVisitor(customer);
    await customer.goto(`/store/${slugA}`);
    await customer.getByLabel("Describe the custom order you have in mind").fill(text);
    await customer.getByRole("button", { name: "Start my request" }).click();
    await customer.waitForURL(/\/o\//);
    await customer.getByRole("button", { name: "Ask the shop to take over" }).first().click();
    await expect(customer.getByRole("heading", { name: "With the shop", level: 2 })).toBeVisible();

    await signIn(page, a);
    await page.goto("/merchant/inquiries");
    const mine = await openRequest(page, text);
    await expect(mine).toContainText("Nothing was recorded before the handover");
    await expect(mine).toContainText(text);
  });

  test("the grid opens one request at a time below it: choosing another row swaps the detail, and the keyboard can choose too", async ({ page, browser }) => {
    const stamp = Date.now();
    const one = `first request ${stamp}`;
    const two = `second request ${stamp}`;
    await customerHandsOver(await (await browser.newContext()).newPage(), one);
    await customerHandsOver(await (await browser.newContext()).newPage(), two);

    await signIn(page, a);
    await page.goto("/merchant/inquiries");
    await page.getByLabel("Search requests").fill(String(stamp));
    const grid = page.getByRole("grid", { name: "Requests" });
    await expect(grid.getByRole("row").filter({ hasText: String(stamp) })).toHaveCount(2);

    const detail = page.getByTestId("grid-detail");
    await grid.getByRole("row").filter({ hasText: one }).first().click();
    await expect(detail).toContainText(one);
    await expect(detail).not.toContainText(two);

    // Keyboard: focus a cell of the other row and press Enter.
    await grid.getByRole("row").filter({ hasText: two }).first().getByRole("gridcell").first().focus();
    await page.keyboard.press("Enter");
    await expect(detail).toContainText(two);
    await expect(detail).not.toContainText(one);
  });

  test("another merchant sees none of it", async ({ page, browser }) => {
    const text = `private to merchant A ${Date.now()}`;
    const customer = await (await browser.newContext()).newPage();
    await customerHandsOver(customer, text);

    await signIn(page, b);
    await page.goto("/merchant/inquiries");
    await expect(page.getByRole("heading", { name: "Requests", level: 1 })).toBeVisible();
    await expect(page.getByText(text)).toHaveCount(0);
    await expect(page.getByText("No inquiries are waiting for you.")).toBeVisible();
  });
});
