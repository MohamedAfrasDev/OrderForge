// The shop builds a price for a request that was handed over, in a real browser against the LOCAL Supabase stack (stand-in model, mocked evidence).
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { adminClient, createSeller, needsLocalSupabase, signIn, type Seller } from "./payments-support";

test("Build a quote is shop-only: a visitor with no session is sent to the login page", async ({ page }) => {
  await page.goto("/merchant/inquiries/00000000-0000-4000-8000-000000000000/quote");
  await expect(page).toHaveURL(/\/merchant\/login$/);
});

test.describe.configure({ mode: "serial" });

test.describe("the shop builds a quote (local Supabase)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  let a: Seller;
  let b: Seller;
  let slugA: string;

  test.beforeAll(async () => {
    db = adminClient();
    a = await createSeller(db, "sqa");
    b = await createSeller(db, "sqb");
    slugA = (await db.from("merchants").select("slug").eq("id", a.merchantId).single()).data!.slug as string;
  });

  async function privateAddress(page: Page) {
    const x = Math.floor(Math.random() * 250) + 1;
    const y = Math.floor(Math.random() * 250) + 1;
    await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `100.64.${x}.${y}` });
  }

  /** The customer describes an order and asks the shop to take over; returns the customer's page and its address. */
  async function handedOver(browser: import("@playwright/test").Browser, message: string) {
    const customer = await (await browser.newContext()).newPage();
    await privateAddress(customer);
    await customer.goto(`/store/${slugA}`);
    await customer.getByLabel("Describe the custom order you have in mind").fill(message);
    await customer.getByRole("button", { name: "Start my request" }).click();
    await customer.waitForURL(/\/o\//);
    await customer.getByRole("button", { name: "Ask the shop to take over" }).first().click();
    await expect(customer.getByRole("heading", { name: "With the shop", level: 2 })).toBeVisible();
    return customer;
  }

  async function openBuilder(page: Page, text: string) {
    await page.goto("/merchant/inquiries");
    await page.getByLabel("Search requests").fill(text);
    await page.getByRole("grid", { name: "Requests" }).getByRole("row").filter({ hasText: text }).first().click();
    await page.getByTestId("grid-detail").getByRole("link", { name: "Build a quote" }).click();
    await expect(page.getByRole("heading", { name: "Build a quote", level: 1 })).toBeVisible();
  }

  const pick = async (page: Page, gift: string) => {
    for (const [slot, sku] of Object.entries({ notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift, card: "CARD-BRANDED", packaging: "PACK-BOX" })) {
      await page.locator(`input[name="slot-${slot}"][value="${sku}"]`).check();
    }
  };

  test("the shop builds the price from its catalog, the customer sees it and can accept it", async ({ page, browser }) => {
    const text = `30 boxes for our team, ref ${Date.now()}`;
    const customer = await handedOver(browser, text);

    await signIn(page, a);
    await openBuilder(page, text);
    // There is no price field: a quantity, a product per part of the box, two fixed notes.
    await expect(page.locator('input[name="price"], input[name="total"], input[name="discount"]')).toHaveCount(0);
    await page.getByLabel("Number of boxes").fill("30");
    await pick(page, "ORGANIZER-DESK");
    await page.getByLabel(/shop will check your artwork/).check();
    await page.getByRole("button", { name: "Send price to the customer" }).click();
    await expect(page.getByRole("status", { name: "Price sent" })).toContainText("$1,080.00 for 30 boxes ($36.00 per box)");

    await customer.reload();
    const price = customer.getByRole("region", { name: "Your price" });
    await expect(price).toContainText("$1,080.00");
    await expect(price.locator("[data-conditions]")).toContainText("The shop will check your artwork");
    await expect(customer.getByText(/The shop prepared your price: \$1,080\.00/)).toBeVisible();
    await price.getByRole("button", { name: "Accept this price" }).click();
    await expect(customer.getByRole("button", { name: "Approve on PayPal" })).toBeVisible();

    // The request has left the shop's list: it has a price now.
    await page.goto("/merchant/inquiries");
    await expect(page.getByText(text)).toHaveCount(0);
  });

  test("a box the shop cannot make is refused in plain words and nothing is sent", async ({ page, browser }) => {
    const text = `a big order, ref ${Date.now()}`;
    const customer = await handedOver(browser, text);

    await signIn(page, a);
    await openBuilder(page, text);
    await page.getByLabel("Number of boxes").fill("30"); // the shop has 24 bottles
    await pick(page, "BOTTLE-STEEL");
    await page.getByRole("button", { name: "Send price to the customer" }).click();
    const alert = page.locator("form").getByRole("alert");
    await expect(alert).toContainText("This box cannot be made as chosen. Nothing was sent to the customer.");
    await expect(alert).toContainText("30 needed, 24 available");
    await expect(alert).not.toContainText("INSUFFICIENT_STOCK");

    await customer.reload();
    await expect(customer.getByRole("region", { name: "Your price" })).toHaveCount(0);
    await expect(customer.getByRole("heading", { name: "With the shop", level: 2 })).toBeVisible();
  });

  test("another shop cannot open it: it says the request is not waiting for them", async ({ page, browser }) => {
    const text = `private to shop A, ref ${Date.now()}`;
    await handedOver(browser, text);
    await signIn(page, a);
    await openBuilder(page, text);
    const url = page.url();

    const other = await (await browser.newContext()).newPage();
    await signIn(other, b);
    await other.goto(url);
    await expect(other.getByText("This request is not waiting for a price from you.")).toBeVisible();
    await expect(other.getByText(text)).toHaveCount(0);
    await expect(other.getByRole("button", { name: "Send price to the customer" })).toHaveCount(0);
  });
});
