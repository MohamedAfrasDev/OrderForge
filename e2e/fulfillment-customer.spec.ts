import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { moveJob } from "../services/fulfillment/move";
import { actorOf, makeJob, paidPurchase } from "./fulfillment-support";
import { acceptedPurchase, adminClient, authorizedPurchase, createSeller, needsLocalSupabase, type Seller } from "./payments-support";

test.describe("the customer's view of a paid order (local Supabase + fake PayPal, mocked evidence)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  let seller: Seller;
  test.beforeAll(async () => {
    db = adminClient();
    seller = await createSeller(db, "fcust");
  });

  const orderRegion = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "Your order" });

  test("there is no order section until the order is paid and has a job", async ({ page }) => {
    const accepted = await acceptedPurchase(db, seller);
    await page.goto(`/o/${accepted.link}`);
    await expect(orderRegion(page)).toHaveCount(0);

    const authorized = await authorizedPurchase(db, seller);
    await page.goto(`/o/${authorized.link}`);
    await expect(page.getByRole("region", { name: "Payment" })).toContainText("authorized with PayPal");
    await expect(orderRegion(page)).toHaveCount(0);

    const paid = await paidPurchase(db, seller);
    await page.goto(`/o/${paid.link}`);
    await expect(page.getByRole("region", { name: "Payment" })).toContainText("Paid");
    await expect(orderRegion(page)).toHaveCount(0); // paid, and the job has not been made yet
  });

  test("once the job exists the customer reads the plain status and the ready-by day, and it follows the merchant", async ({ page }) => {
    const p = await paidPurchase(db, seller);
    const jobId = await makeJob(db, p.purchaseId);
    await page.goto(`/o/${p.link}`);
    await expect(orderRegion(page)).toContainText(/We are preparing your order\. We aim to have it ready by \d{4}-\d{2}-\d{2}\./);

    const actor = actorOf(seller);
    const ctx = () => ({ now: new Date().toISOString(), correlationId: "e2e-fulfillment-customer" });
    await moveJob(db, actor, jobId, "PREPARING", {}, ctx());
    await moveJob(db, actor, jobId, "READY_FOR_PICKUP", {}, ctx());
    await page.reload();
    await expect(orderRegion(page)).toContainText("Your order is ready for pickup.");

    await moveJob(db, actor, jobId, "COLLECTED", {}, ctx());
    await page.reload();
    await expect(orderRegion(page)).toContainText("Your order has been collected. Thank you.");
  });

  test("shows no worksheet, no note and no ids", async ({ page }) => {
    const p = await paidPurchase(db, seller);
    const jobId = await makeJob(db, p.purchaseId);
    await moveJob(db, actorOf(seller), jobId, "ON_HOLD", { note: "Internal: supplier problem." }, { now: new Date().toISOString(), correlationId: "e2e-fulfillment-customer" });
    await page.goto(`/o/${p.link}`);
    const region = orderRegion(page);
    await expect(region).toContainText("Your order is delayed");
    const text = (await region.innerText()).toLowerCase();
    expect(text).not.toMatch(/internal|supplier|organizer|notebook|pick list|worksheet|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  test("another customer's page never shows this job", async ({ page }) => {
    const mine = await paidPurchase(db, seller);
    await makeJob(db, mine.purchaseId);
    const other = await acceptedPurchase(db, seller);
    await page.goto(`/o/${other.link}`);
    await expect(orderRegion(page)).toHaveCount(0);
  });
});
