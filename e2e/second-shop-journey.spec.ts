// The second demo shop (Demo Event Kits) in a real browser against the LOCAL Supabase stack: the same engine, a different catalog. The assistant
// is the rule-based stand-in (mocked), PayPal is the local fake (mocked) and no email is involved. Nothing reaches a real service.
//   Run 1: from the home page to collected: 20 kits with the insulated bottle, $33.50 a kit, $670.
//   Run 2: 50 kits: the bottle (40 in stock) is blocked, the engine offers the enamel mug, $29.50 a kit, $1,475.
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { adminClient, approveAtFake, attemptOf, needsLocalSupabase, signIn } from "./payments-support";
import { DEMO_STORE_SLUG } from "../lib/demo-store";
import { expectStage, privateAddress, type Shop } from "./journey-support";
import { readyKitShop } from "./second-shop-support";

test.describe("the second shop, event welcome kits (local Supabase, stand-in model, fake PayPal: mocked)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  let db: SupabaseClient;
  let kit: Shop;

  test.beforeAll(async () => {
    db = adminClient();
    // The home page offers the second shop under the first, so the first must exist. It is only made to exist here (as the home page spec does):
    // this file must not call readyDemoShop, which resets the first shop's login and stock while the other journey specs are using them.
    const bare = await db.from("merchants").upsert({ slug: DEMO_STORE_SLUG, name: "Demo Gift Boxes (simulated)" }, { onConflict: "slug", ignoreDuplicates: true });
    if (bare.error) throw new Error(bare.error.message);
    kit = await readyKitShop(db);
  });

  test("from the home page to collected: 20 kits, $33.50 a kit, $670, the kit shop's own owner does the rest", async ({ page, browser }) => {
    await privateAddress(page);
    await page.goto("/");
    await page.getByRole("link", { name: /Demo Event Kits/ }).click();
    await expect(page).toHaveURL(/\/store\/demo-event-kits$/);
    await expect(page.getByRole("heading", { name: kit.name })).toBeVisible();

    await page.getByLabel("Describe the custom order you have in mind").fill("No food, our logo, under $40 per box");
    await page.getByRole("button", { name: "Start my request" }).click();
    await page.waitForURL(/\/o\//);
    const orderUrl = page.url();
    await expectStage(page, "We need one answer", "Describe");
    const inquiry = await db.from("inquiries").select("id").eq("merchant_id", kit.merchantId).order("created_at", { ascending: false }).limit(1).single();
    const inquiryId = inquiry.data!.id as string;

    // One tap answers the one open question; the box that comes back is the kit shop's, priced from its catalog.
    await page.getByRole("region", { name: "Open question" }).getByRole("button", { name: "20 boxes" }).click();
    const proposals = page.getByRole("region", { name: "Proposals" });
    await expect(proposals).toContainText("$33.50 per box · $670.00 for 20 boxes");
    for (const item of ["Canvas tote bag", "Printed lanyard", "Insulated bottle", "Sticker pack", "Kit mailer box"]) await expect(proposals).toContainText(item);
    for (const other of ["Steel water bottle", "notebook", "Desk organizer", "Chocolate"]) await expect(proposals).not.toContainText(other);
    await expectStage(page, "Choose your box", "Choose");

    await proposals.getByRole("button", { name: "Choose this box" }).click();
    const price = page.getByRole("region", { name: "Your price" });
    await expect(price).toContainText("$670.00");
    await expect(price).toContainText("$33.50");
    await price.getByRole("button", { name: "Accept this price" }).click();
    await expect(price.getByRole("status")).toContainText("You accepted this exact price");
    await expectStage(page, "Approve your order on PayPal", "Approve");

    // Approve on PayPal (the fake): the sandbox page is not loaded, the redirect to it is checked.
    const payment = page.getByRole("region", { name: "Payment" });
    await expect(payment).toContainText("You won't be charged yet.");
    await page.route("https://www.sandbox.paypal.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>PayPal sandbox page</p>" }));
    await payment.getByRole("button", { name: "Approve on PayPal" }).click();
    await expect(page).toHaveURL(/https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=FAKEORDER\d+/);
    const purchase = await db.from("purchases").select("id, merchant_id").eq("inquiry_id", inquiryId).single();
    expect(purchase.data!.merchant_id).toBe(kit.merchantId);
    const attempt = await attemptOf(db, purchase.data!.id as string);
    await approveAtFake(attempt.paypal_order_id!);
    await page.goto(`${orderUrl}/return?token=${attempt.paypal_order_id}`);
    await expectStage(page, "Waiting for the shop to confirm", "Shop confirms");

    // The kit shop's own owner sees this order on Today, accepts it, prepares it and hands it over.
    const shopContext = await browser.newContext();
    const shopPage = await shopContext.newPage();
    await signIn(shopPage, kit);
    await expect(shopPage.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
    await expect(shopPage.getByTestId("today-payments")).toContainText("waiting for your OK");
    await shopPage.getByRole("link", { name: "Review orders" }).click();
    const id8 = inquiryId.slice(0, 8);
    await shopPage.getByRole("row", { name: new RegExp(id8) }).first().click();
    const order = shopPage.getByRole("article", { name: new RegExp(id8) });
    await expect(order).toContainText("$670.00");
    await order.getByRole("button", { name: /Accept/ }).click();
    await expect(shopPage.getByRole("row", { name: new RegExp(id8) })).toHaveCount(0);
    await page.goto(orderUrl);
    await expectStage(page, "Your order is being prepared", "Pick up");

    await shopPage.goto("/merchant");
    await shopPage.getByRole("link", { name: "Prepare orders" }).click();
    await shopPage.getByRole("row", { name: new RegExp(id8) }).first().click();
    const job = shopPage.getByRole("article", { name: new RegExp(`Job for request ${id8}`) });
    await expect(job).toContainText("Insulated bottle"); // the pick list is the kit shop's, from the accepted price
    await job.getByRole("button", { name: "Start preparing" }).click();
    await expect(job).toContainText("Status: Preparing");
    await job.getByRole("button", { name: "Mark ready for pickup" }).click();
    await expect(job).toContainText("Status: Ready for pickup");
    await page.goto(orderUrl);
    await expectStage(page, "Your order is ready for pickup", "Pick up");
    await job.getByRole("button", { name: "Record pickup" }).click();
    await expect(shopPage.getByRole("region", { name: "Collected" }).getByRole("row", { name: new RegExp(id8) })).toBeVisible();
    await page.goto(orderUrl);
    await expectStage(page, "Collected", null);

    // Isolation in the browser: the kit shop's owner sees no trace of the gift-box shop's work.
    await shopPage.goto("/merchant/catalog");
    await expect(shopPage.getByText("Canvas tote bag").first()).toBeVisible();
    await expect(shopPage.getByText("Steel water bottle")).toHaveCount(0);
    await shopContext.close();

    const settled = await db.from("payment_attempts").select("state").eq("purchase_id", purchase.data!.id as string).single();
    expect(settled.data!.state).toBe("CAPTURED");
  });

  test("50 kits: the insulated bottle is out of stock at that quantity, code offers the enamel mug, $29.50 a kit, $1,475", async ({ page }) => {
    await privateAddress(page);
    await page.goto(`/store/${kit.slug}`);
    await page.getByLabel("Describe the custom order you have in mind").fill("No food, our logo, under $40 per box");
    await page.getByRole("button", { name: "Start my request" }).click();
    await page.waitForURL(/\/o\//);

    await page.getByLabel("Write to the assistant").fill("Make it 50 boxes");
    await page.getByRole("button", { name: "Send" }).click();
    const proposals = page.getByRole("region", { name: "Proposals" });
    await expect(proposals).toContainText("We can't make the first box we picked");
    await expect(proposals).toContainText("Replace Insulated bottle with Enamel mug");
    await expect(proposals).toContainText("Enamel mug (swapped in)");
    await expect(proposals).toContainText("$29.50 per box · $1,475.00 in total");

    await proposals.getByRole("button", { name: "Choose this box" }).click();
    const price = page.getByRole("region", { name: "Your price" });
    await expect(price).toContainText("$1,475.00");
    await expect(price).toContainText("$29.50");
    await price.getByRole("button", { name: "Accept this price" }).click();
    await expect(price.getByRole("status")).toContainText("You accepted this exact price");
  });
});
