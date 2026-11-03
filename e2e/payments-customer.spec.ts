import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { acceptedPurchase, adminClient, approveAtFake, attemptOf, createSeller, needsLocalSupabase, type Seller } from "./payments-support";

test.describe("paying for an accepted quote (local Supabase + fake PayPal, mocked evidence)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  let seller: Seller;
  test.beforeAll(async () => {
    db = adminClient();
    seller = await createSeller(db, "cust");
  });

  test("the customer pays with PayPal, comes back, and sees the payment waiting for the merchant", async ({ page }) => {
    const p = await acceptedPurchase(db, seller);
    // The sandbox approval page is not ours to load: the redirect to it is checked, then the buyer's approval is simulated.
    await page.route("https://www.sandbox.paypal.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>PayPal sandbox page</p>" }));

    await page.goto(`/o/${p.link}`);
    const payment = page.getByRole("region", { name: "Payment" });
    await expect(payment).toContainText("Pay with PayPal to confirm your order");
    await payment.getByRole("button", { name: "Pay with PayPal" }).click();
    await expect(page).toHaveURL(/https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=FAKEORDER\d+/);

    const attempt = await attemptOf(db, p.purchaseId);
    expect(attempt.state).toBe("PROVIDER_CREATED");
    await approveAtFake(attempt.paypal_order_id!);

    // PayPal sends the buyer back with the order id as `token`.
    await page.goto(`/o/${p.link}/return?token=${attempt.paypal_order_id}`);
    await expect(page).toHaveURL(new RegExp(`/o/${p.link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?payment=DONE$`));
    await expect(payment).toContainText("Thank you. Your payment is authorized with PayPal");
    await expect(payment).toContainText("you are charged only when they do");
    await expect(payment.getByRole("button")).toHaveCount(0);
    expect((await attemptOf(db, p.purchaseId)).state).toBe("AUTHORIZED");

    // Coming back a second time is harmless: still one authorization.
    await page.goto(`/o/${p.link}/return?token=${attempt.paypal_order_id}`);
    await expect(payment).toContainText("waiting for the merchant");
    expect((await attemptOf(db, p.purchaseId)).state).toBe("AUTHORIZED");
    const authorized = await db.from("payment_events").select("id").eq("payment_attempt_id", attempt.id).eq("event_type", "payment.authorized");
    expect(authorized.data).toHaveLength(1);
  });

  test("coming back without having approved says so, and nothing is authorized", async ({ page }) => {
    const p = await acceptedPurchase(db, seller);
    await page.route("https://www.sandbox.paypal.com/**", (route) => route.fulfill({ status: 200, body: "PayPal" }));
    await page.goto(`/o/${p.link}`);
    await page.getByRole("button", { name: "Pay with PayPal" }).click();
    await expect(page).toHaveURL(/checkoutnow/);
    const attempt = await attemptOf(db, p.purchaseId);

    await page.goto(`/o/${p.link}/return?token=${attempt.paypal_order_id}`);
    await expect(page.getByRole("region", { name: "Payment" })).toContainText("PayPal does not show your payment as approved yet");
    expect((await attemptOf(db, p.purchaseId)).state).toBe("PROVIDER_CREATED");
    // The customer can carry on from where they were.
    await expect(page.getByRole("button", { name: "Continue with PayPal" })).toBeVisible();
  });

  test("an order id that is not this customer's gets the general message and changes nothing", async ({ page }) => {
    const mine = await acceptedPurchase(db, seller);
    const theirs = await acceptedPurchase(db, seller);
    await page.route("https://www.sandbox.paypal.com/**", (route) => route.fulfill({ status: 200, body: "PayPal" }));
    await page.goto(`/o/${theirs.link}`);
    await page.getByRole("button", { name: "Pay with PayPal" }).click();
    await expect(page).toHaveURL(/checkoutnow/);
    const other = await attemptOf(db, theirs.purchaseId);
    await approveAtFake(other.paypal_order_id!);

    await page.goto(`/o/${mine.link}/return?token=${other.paypal_order_id}`);
    await expect(page.getByRole("region", { name: "Payment" })).toContainText("That could not be done right now");
    expect((await attemptOf(db, theirs.purchaseId)).state).toBe("PROVIDER_CREATED");
  });

  test("a made-up notice in the address shows nothing", async ({ page }) => {
    const p = await acceptedPurchase(db, seller);
    await page.goto(`/o/${p.link}?payment=<script>alert(1)</script>`);
    await expect(page.getByRole("region", { name: "Payment" })).not.toContainText("alert");
    await expect(page.getByRole("region", { name: "Payment" }).getByRole("status")).toHaveCount(0);
  });

  test("a wrong link is not found and shows no payment", async ({ page }) => {
    const response = await page.goto("/o/not-a-real-link/return?token=FAKEORDER1");
    expect(response?.status()).toBe(404);
  });
});
