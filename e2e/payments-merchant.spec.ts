import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { adminClient, attemptOf, authorizedPurchase, createSeller, needsLocalSupabase, signIn, type Seller } from "./payments-support";

const SLOT = { code: "PRODUCTION_SLOT_CONFIRMATION", text: "Production slot to be confirmed." };

test("the decisions page is merchant-only: a visitor with no session is sent to the login page", async ({ page }) => {
  await page.goto("/merchant/decisions");
  await expect(page).toHaveURL(/\/merchant\/login$/);
});

test.describe("deciding on authorized orders (local Supabase + fake PayPal, mocked evidence)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  let a: Seller;
  let b: Seller;
  test.beforeAll(async () => {
    db = adminClient();
    a = await createSeller(db, "a");
    b = await createSeller(db, "b");
  });

  const cardFor = (page: Page, inquiryId: string) => page.getByRole("article", { name: new RegExp(inquiryId.slice(0, 8)) });

  /** Chooses the order's row in its grid, which opens its card below, and returns the card. */
  const openCard = async (page: Page, inquiryId: string) => {
    await page.getByRole("row", { name: new RegExp(inquiryId.slice(0, 8)) }).first().click();
    return cardFor(page, inquiryId);
  };

  test("the merchant confirms the listed condition and accepts: the payment is taken once, even on a double click", async ({ page }) => {
    const p = await authorizedPurchase(db, a, [SLOT]);
    await signIn(page, a);
    await page.getByRole("link", { name: "Review orders" }).click();
    await expect(page).toHaveURL(/\/merchant\/decisions$/);

    const card = await openCard(page, p.inquiryId);
    await expect(card).toContainText("Total $1,080.00");
    await expect(card).toContainText("PayPal is holding $1,080.00; the customer has not been charged.");
    // One accept and one decline, each saying what it does.
    await expect(card).toContainText("PayPal charges the $1,080.00 it is holding, once, and the order moves on to preparation.");
    await expect(card).toContainText("The $1,080.00 hold is released, the customer is not charged and the stock is freed.");
    await expect(card.getByRole("button", { name: "Accept and take payment" })).toHaveCount(1);
    await expect(card.getByRole("button", { name: /Decline/ })).toHaveCount(1);
    await expect(card).toContainText("Production slot to be confirmed.");

    // Without confirming the condition, nothing is decided.
    await card.getByRole("button", { name: "Accept and take payment" }).click();
    await expect(card.getByRole("alert")).toContainText("Confirm every condition");
    expect((await attemptOf(db, p.purchaseId)).state).toBe("AUTHORIZED");

    await card.getByLabel("Production slot to be confirmed.").check();
    await card.getByRole("button", { name: /Accept/ }).dblclick();
    await expect.poll(async () => (await attemptOf(db, p.purchaseId)).state, { timeout: 15_000 }).toBe("CAPTURED");

    const attempt = await attemptOf(db, p.purchaseId);
    const captures = await db.from("payment_events").select("id").eq("payment_attempt_id", attempt.id).eq("event_type", "payment.captured");
    expect(captures.data).toHaveLength(1);
    const decisions = await db.from("merchant_decisions").select("decision").eq("purchase_id", p.purchaseId);
    expect(decisions.data).toEqual([{ decision: "accepted" }]);

    await page.reload();
    await expect(cardFor(page, p.inquiryId)).toHaveCount(0);
    // Both sides end on a clear result: the shop sees it under "Recently decided", and the customer's page says the order is confirmed.
    const decided = page.getByRole("region", { name: "Recently decided" });
    await expect(decided).toContainText(`Request ${p.inquiryId.slice(0, 8)}`);
    await expect(decided).toContainText("Accepted. $1,080.00 was charged, once. The order moves on to preparation.");
  });

  test("the merchant declines with a reason: the authorization is cancelled and the customer is told", async ({ page, browser }) => {
    const p = await authorizedPurchase(db, a);
    await signIn(page, a);
    await page.goto("/merchant/decisions");

    const card = await openCard(page, p.inquiryId);
    await card.getByRole("button", { name: /Decline/ }).click();
    await expect(card.getByRole("alert")).toContainText("Write a reason for declining");
    expect((await attemptOf(db, p.purchaseId)).state).toBe("AUTHORIZED");

    await card.getByLabel("Reason for declining").fill("Cannot make it in time.");
    await card.getByRole("button", { name: /Decline/ }).click();
    await expect.poll(async () => (await attemptOf(db, p.purchaseId)).state, { timeout: 15_000 }).toBe("VOIDED");

    const customer = await (await browser.newContext()).newPage();
    await customer.goto(`/o/${p.link}`);
    await expect(customer.getByRole("region", { name: "Payment" })).toContainText("you weren't charged");
    await expect(customer.getByRole("region", { name: "Payment" }).locator('[data-conclusion="declined"]')).toContainText("PayPal has released the hold, so nothing was taken from you.");

    await page.goto("/merchant/decisions");
    await expect(page.getByRole("region", { name: "Recently decided" })).toContainText("Declined. The hold was released, the customer was not charged and the stock is free.");
    await expect(customer.getByRole("region", { name: "Payment" }).getByRole("button")).toHaveCount(0);
  });

  test("a merchant sees only their own orders", async ({ page }) => {
    const mine = await authorizedPurchase(db, a);
    const theirs = await authorizedPurchase(db, b);
    await signIn(page, a);
    await page.goto("/merchant/decisions");
    await expect(await openCard(page, mine.inquiryId)).toBeVisible();
    await expect(cardFor(page, theirs.inquiryId)).toHaveCount(0);
    await expect(page.getByRole("row", { name: new RegExp(theirs.inquiryId.slice(0, 8)) })).toHaveCount(0); // not in the grid either
  });

  test("an empty list says so", async ({ page }) => {
    const c = await createSeller(db, "c");
    await signIn(page, c);
    await page.goto("/merchant/decisions");
    await expect(page.getByRole("region", { name: "Waiting for your decision" })).toContainText("No authorized orders are waiting.");
    await expect(page.getByRole("region", { name: "Needs attention" })).toContainText("Nothing needs attention.");
  });
});
