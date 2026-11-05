// The whole journey as one function, so the desktop run and the phone-width run walk exactly the same path. Everything here is mocked or local:
// the stand-in model on the server, the local fake PayPal, and the fake email provider (run in the test process). Nothing reaches a real service.
import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import { boxTemplate, products, stock } from "../supabase/seed/fixtures";
import { createFakeEmail } from "../lib/email/fake";
import { drainNotifications } from "../services/notifications/drain";
import { DEMO_STORE_SLUG } from "../lib/demo-store";
import { approveAtFake, attemptOf, signIn, type Seller } from "./payments-support";

/** Called after each stage with its name and the page, and the page's main action if it has one. The phone run uses it to check the layout. */
export type StageCheck = (stage: string, page: Page, main?: Locator) => Promise<void>;

export type Shop = Seller & { slug: string; name: string };

/**
 * The demo store, made ready to take real orders: its catalog, plenty of stock, and a shop login whose password this run knows. It is a store
 * in the LOCAL database only (the home page spec creates the same row bare). Stock is topped up so repeated runs never run out.
 */
export async function readyDemoShop(db: SupabaseClient): Promise<Shop> {
  const made = await db.from("merchants").upsert({ slug: DEMO_STORE_SLUG, name: "Demo Gift Boxes (simulated)" }, { onConflict: "slug", ignoreDuplicates: true });
  if (made.error) throw new Error(`merchant: ${made.error.message}`);
  const merchant = await db.from("merchants").select("id, name").eq("slug", DEMO_STORE_SLUG).single();
  if (merchant.error) throw new Error(`merchant: ${merchant.error.message}`);
  const merchantId = merchant.data.id as string;

  const have = await db.from("products").select("id").eq("merchant_id", merchantId);
  if ((have.data ?? []).length === 0) {
    const ids = new Map(products.map((p) => [p.id, randomUUID()]));
    const inserted = await db.from("products").upsert(products.map((p) => ({ ...p, id: ids.get(p.id)!, merchant_id: merchantId })), { onConflict: "merchant_id,sku", ignoreDuplicates: true });
    if (inserted.error) throw new Error(`products: ${inserted.error.message}`);
    const rows = await db.from("products").select("id, sku").eq("merchant_id", merchantId);
    const idOf = new Map((rows.data ?? []).map((r) => [r.sku as string, r.id as string]));
    const bySku = new Map(products.map((p) => [p.id, p.sku]));
    const stocked = await db.from("stock").upsert(stock.map((s) => ({ ...s, product_id: idOf.get(bySku.get(s.product_id)!)! })), { onConflict: "product_id", ignoreDuplicates: true });
    if (stocked.error) throw new Error(`stock: ${stocked.error.message}`);
    const rules = await db.from("business_rules").upsert(
      [
        { merchant_id: merchantId, key: "box_template", value: boxTemplate },
        { merchant_id: merchantId, key: "production_lead_days", value: { days: 7 } },
      ],
      { onConflict: "merchant_id,key", ignoreDuplicates: true },
    );
    if (rules.error) throw new Error(`rules: ${rules.error.message}`);
  }
  // Plenty on hand for every product, the bottle too, so a run never depends on what earlier runs used up.
  const all = await db.from("products").select("id, sku").eq("merchant_id", merchantId);
  for (const p of all.data ?? []) {
    await db.from("stock").update({ on_hand: 5000 }).eq("product_id", p.id as string);
  }

  // One fixed shop login for the demo store, used by every journey spec. The two specs run at the same time, so this must not hand out a new
  // owner each time; it creates the user once, and later calls only make sure the password is the known one and the user owns the store.
  // (A test-only credential for the LOCAL database; the address cannot receive mail.)
  const email = "e2e-journey-shop@test.invalid";
  const password = "e2e-journey-local-only-9f3a1c";
  let userId: string | undefined;
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.data.user) userId = created.data.user.id;
  else {
    // Already there (made by an earlier run or by the other journey spec a moment ago): find it by its address, never by who owns the store.
    // The local database collects test users from every run, so the one we want may be on a later page.
    for (let page = 1; page <= 200 && !userId; page++) {
      const listed = await db.auth.admin.listUsers({ page, perPage: 1000 });
      userId = listed.data.users.find((u) => u.email === email)?.id;
      if (listed.data.users.length < 1000) break;
    }
    if (!userId) throw new Error(`shop user: ${created.error?.message}`);
    await db.auth.admin.updateUserById(userId, { password, email_confirm: true });
  }
  const owned = await db.from("merchants").update({ owner_user_id: userId }).eq("id", merchantId);
  if (owned.error) throw new Error(`owner: ${owned.error.message}`);
  return { merchantId, email, password, slug: DEMO_STORE_SLUG, name: merchant.data.name as string };
}

export async function privateAddress(page: Page) {
  const a = Math.floor(Math.random() * 250) + 1;
  const b = Math.floor(Math.random() * 250) + 1;
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `100.64.${a}.${b}` });
}

/** The progress strip as a list of "label: state". */
export async function stripOf(page: Page): Promise<string[]> {
  const items = page.getByRole("list", { name: "Your progress" }).getByRole("listitem");
  return items.evaluateAll((els) => els.map((el) => `${el.textContent?.replace(/^Step \d of \d: /, "").replace(/, (done|you are here|stopped here|still to come).*$/, "")}: ${el.getAttribute("data-state")}`));
}

export async function expectStage(page: Page, headline: string, current: string | null) {
  await expect(page.getByTestId("order-header").getByRole("heading", { level: 2, name: headline, exact: true })).toBeVisible();
  const strip = await stripOf(page);
  expect(strip).toHaveLength(6);
  if (current === null) {
    expect(strip.every((s) => s.endsWith(": done"))).toBe(true);
  } else {
    expect(strip.filter((s) => s.endsWith(": current") || s.endsWith(": stopped"))).toEqual([expect.stringContaining(current)]);
  }
}

export const kindsOf = async (db: SupabaseClient, inquiryId: string): Promise<string[]> => {
  const rows = await db.from("notifications").select("kind").eq("inquiry_id", inquiryId);
  return (rows.data ?? []).map((r) => r.kind as string).sort();
};

/** The emails the server queued so far are exactly these (each once), waiting for the server's own best-effort pass if it has not run yet. */
export async function expectQueued(db: SupabaseClient, inquiryId: string, expected: string[]) {
  await expect.poll(() => kindsOf(db, inquiryId), { timeout: 15_000 }).toEqual([...expected].sort());
}

/**
 * The server has no email provider here, so it marks what it queues SKIPPED. To see what would have been sent, the rows are put back to
 * PENDING and drained here with a recording fake. The fake is the only thing that "sends".
 */
export async function replayWithFake(db: SupabaseClient, inquiryId: string) {
  const port = createFakeEmail();
  const all = await db.from("notifications").select("id").eq("inquiry_id", inquiryId);
  const total = (all.data ?? []).length;
  // Other specs share this server, whose own background pass may turn a pending row into a skipped one a moment before this drain gets it.
  // So: put back whatever has not been delivered here yet, send only this request's rows, and repeat until every row has gone through the fake.
  for (let round = 0; round < 8 && port.delivered.length < total; round++) {
    const done = new Set(port.delivered.map((m) => m.idempotencyKey));
    const back = await db.from("notifications").update({ status: "PENDING", attempts: 0, sent_at: null }).eq("inquiry_id", inquiryId).not("id", "in", `(${[...done, "00000000-0000-0000-0000-000000000000"].join(",")})`);
    if (back.error) throw new Error(`requeue: ${back.error.message}`);
    await drainNotifications(db, { port, accessSecret: process.env.E2E_ACCESS_LINK_SECRET!, appBaseUrl: "http://localhost:3100" }, { now: new Date().toISOString(), inquiryId });
  }
  return port;
}

const sorted = (list: string[]) => [...list].sort();

const noSideways = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

/** A page-width check for the phone run: no sideways scroll, and the main action is on the screen without zooming. */
export const phoneCheck: StageCheck = async (stage, page, main) => {
  await noSideways(page);
  if (!main) return;
  await expect(main, `${stage}: the main action is visible`).toBeVisible();
  const box = await main.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box, `${stage}: the main action has a box`).not.toBeNull();
  expect(box!.x, `${stage}: starts on the screen`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${stage}: ends on the screen`).toBeLessThanOrEqual(width);
};

/**
 * Run 1: from the home page to "collected". Start with an email, the assistant reads the request, one quick reply, a box is chosen, the
 * price is read and accepted, PayPal approves (fake), the shop accepts, prepares and hands over. The strip, the headline and the emails
 * queued are checked at each step; the emails are then replayed through a recording fake.
 */
export async function wholeJourney(args: { page: Page; browser: Browser; db: SupabaseClient; shop: Shop; check?: StageCheck; viewport?: { width: number; height: number } }) {
  const { page, browser, db, shop } = args;
  const check = args.check ?? (async () => undefined);
  const email = `sam.${randomBytes(3).toString("hex")}@example.com`;

  await privateAddress(page);
  await page.goto("/");
  await check("home", page, page.getByRole("link", { name: "Try it as a customer" }));
  await page.getByRole("link", { name: "Try it as a customer" }).click();
  await expect(page.getByRole("heading", { name: shop.name })).toBeVisible();
  await check("store page", page, page.getByRole("button", { name: "Start my request" }));

  // 1. Describe, with an email.
  await page.getByLabel("Describe the custom order you have in mind").fill("No food, our logo, under $40 per box");
  await page.getByLabel(/^Email/).fill(email);
  await page.getByRole("button", { name: "Start my request" }).click();
  await page.waitForURL(/\/o\//);
  const orderUrl = page.url();
  await expectStage(page, "We need one answer", "Describe");
  const inquiry = await db.from("inquiries").select("id").eq("customer_email", email).single();
  if (inquiry.error) throw new Error(`inquiry: ${inquiry.error.message}`);
  const inquiryId = inquiry.data.id as string;
  await expectQueued(db, inquiryId, ["request_started"]);
  await check("order: one answer needed", page, page.getByRole("region", { name: "Open question" }).getByRole("button", { name: "20 boxes" }));

  // 2. One tap on a quick reply answers the question.
  await page.getByRole("region", { name: "Open question" }).getByRole("button", { name: "20 boxes" }).click();
  const proposals = page.getByRole("region", { name: "Proposals" });
  await expect(proposals).toContainText("$35.00 per box · $700.00 for 20 boxes");
  await expectStage(page, "Choose your box", "Choose");
  await check("order: choose a box", page, proposals.getByRole("button", { name: "Choose this box" }));

  // 3. Choose the box: the price.
  await proposals.getByRole("button", { name: "Choose this box" }).click();
  const price = page.getByRole("region", { name: "Your price" });
  await expect(price).toContainText("$700.00");
  await expectStage(page, "Review your price", "Review price");
  await expectQueued(db, inquiryId, ["price_ready", "request_started"]);
  await check("order: review the price", page, price.getByRole("button", { name: "Accept this price" }));

  // 4. Accept, then approve on PayPal (the sandbox page is not loaded: the redirect to it is checked, and the buyer's approval is made at the fake).
  await price.getByRole("button", { name: "Accept this price" }).click();
  await expect(price.getByRole("status")).toContainText("You accepted this exact price");
  await expectStage(page, "Approve your order on PayPal", "Approve");
  const payment = page.getByRole("region", { name: "Payment" });
  await expect(payment).toContainText("You won't be charged yet.");
  await check("order: approve on PayPal", page, payment.getByRole("button", { name: "Approve on PayPal" }));
  await page.route("https://www.sandbox.paypal.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>PayPal sandbox page</p>" }));
  await payment.getByRole("button", { name: "Approve on PayPal" }).click();
  await expect(page).toHaveURL(/https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=FAKEORDER\d+/);
  const purchase = await db.from("purchases").select("id").eq("inquiry_id", inquiryId).single();
  const attempt = await attemptOf(db, purchase.data!.id as string);
  await approveAtFake(attempt.paypal_order_id!);
  await page.goto(`${orderUrl}/return?token=${attempt.paypal_order_id}`);
  await expectStage(page, "Waiting for the shop to confirm", "Shop confirms");
  await check("order: waiting for the shop", page);
  await expectQueued(db, inquiryId, ["order_awaiting_ok", "price_ready", "request_started"]);

  // 5. The shop: Today shows the order, the shop accepts it.
  const shopContext = await browser.newContext({ viewport: args.viewport });
  const shopPage = await shopContext.newPage();
  await signIn(shopPage, shop);
  await expect(shopPage.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
  await check("shop: Today", shopPage, shopPage.getByRole("link", { name: "Review orders" }));
  await expect(shopPage.getByTestId("today-payments")).toContainText("waiting for your OK");
  await shopPage.getByRole("link", { name: "Review orders" }).click();
  const id8 = inquiryId.slice(0, 8);
  await shopPage.getByRole("row", { name: new RegExp(id8) }).first().click();
  const order = shopPage.getByRole("article", { name: new RegExp(id8) });
  await check("shop: an order to decide", shopPage, order.getByRole("button", { name: /Accept/ }));
  await order.getByRole("button", { name: /Accept/ }).click();
  await expect(shopPage.getByRole("row", { name: new RegExp(id8) })).toHaveCount(0);

  await page.goto(orderUrl);
  await expectStage(page, "Your order is being prepared", "Pick up");
  await expectQueued(db, inquiryId, ["order_accepted", "order_awaiting_ok", "price_ready", "request_started"]);

  // 6. The shop prepares it and hands it over; the customer sees each step.
  await shopPage.goto("/merchant");
  await shopPage.getByRole("link", { name: "Prepare orders" }).click();
  await shopPage.getByRole("row", { name: new RegExp(id8) }).first().click();
  const job = shopPage.getByRole("article", { name: new RegExp(`Job for request ${id8}`) });
  await check("shop: a job to prepare", shopPage, job.getByRole("button", { name: "Start preparing" }));
  await job.getByRole("button", { name: "Start preparing" }).click();
  await expect(job).toContainText("Status: Preparing");
  await job.getByRole("button", { name: "Mark ready for pickup" }).click();
  await expect(job).toContainText("Status: Ready for pickup");
  await page.goto(orderUrl);
  await expectStage(page, "Your order is ready for pickup", "Pick up");
  await expectQueued(db, inquiryId, ["order_accepted", "order_awaiting_ok", "price_ready", "ready_for_pickup", "request_started"]);
  await check("order: ready for pickup", page);

  await job.getByRole("button", { name: "Record pickup" }).click();
  await expect(shopPage.getByRole("region", { name: "Collected" }).getByRole("row", { name: new RegExp(id8) })).toBeVisible(); // it moved to the collected list
  await page.goto(orderUrl);
  await expectStage(page, "Collected", null);
  await check("order: collected", page);
  await shopContext.close();

  // 7. What would have been emailed, once each, in the customer's words (the fake is the only thing that "sends").
  const port = await replayWithFake(db, inquiryId);
  const mine = port.delivered;
  expect(mine.map((m) => m.subject).sort()).toEqual(sorted([
    "Your request to Demo Gift Boxes (simulated) is saved (sandbox demo)",
    "Demo Gift Boxes (simulated) prepared your price (sandbox demo)",
    "An order is waiting for your OK (sandbox demo)",
    "Demo Gift Boxes (simulated) accepted your order (sandbox demo)",
    "Your order is ready for pickup (sandbox demo)",
  ]));
  expect(mine.filter((m) => m.to === email)).toHaveLength(4);
  expect(mine.filter((m) => m.to === shop.email)).toHaveLength(1);
  expect(new Set(mine.map((m) => m.idempotencyKey)).size).toBe(5); // once each
  expect(mine.find((m) => m.subject.includes("prepared your price"))!.text).toContain("$700.00 for 20 boxes");
  expect(mine.find((m) => m.subject.includes("accepted your order"))!.text).toContain("PayPal took $700.00");
  return { email, inquiryId, orderUrl, mine };
}

/**
 * Run 2: the handed-over path. The customer asks the shop to take over, the shop builds a quote from the request, the customer accepts it.
 */
export async function handedOverJourney(args: { page: Page; browser: Browser; db: SupabaseClient; shop: Shop; check?: StageCheck; viewport?: { width: number; height: number } }) {
  const { page, browser, db, shop } = args;
  const check = args.check ?? (async () => undefined);
  const email = `lee.${randomBytes(3).toString("hex")}@example.com`;
  const text = `Thirty boxes for our team, ref ${randomBytes(3).toString("hex")}`;

  await privateAddress(page);
  await page.goto(`/store/${shop.slug}`);
  await page.getByLabel("Describe the custom order you have in mind").fill(text);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByRole("button", { name: "Start my request" }).click();
  await page.waitForURL(/\/o\//);
  const orderUrl = page.url();
  await page.getByRole("button", { name: "Ask the shop to take over" }).first().click();
  await expectStage(page, "With the shop", "Choose");
  await check("order: with the shop", page);
  const inquiry = await db.from("inquiries").select("id").eq("customer_email", email).single();
  const inquiryId = inquiry.data!.id as string;
  await expectQueued(db, inquiryId, ["request_handed_over", "request_started"]);

  const shopContext = await browser.newContext({ viewport: args.viewport });
  const shopPage = await shopContext.newPage();
  await signIn(shopPage, shop);
  await check("shop: Today", shopPage, shopPage.getByRole("link", { name: "Open requests" }));
  await expect(shopPage.getByTestId("today-requests")).toContainText("needs your answer").catch(() => expect(shopPage.getByTestId("today-requests")).toContainText("need your answer"));
  await shopPage.getByRole("link", { name: "Open requests" }).click();
  await shopPage.getByLabel("Search requests").fill(text);
  await shopPage.getByRole("grid", { name: "Requests" }).getByRole("row").filter({ hasText: text }).first().click();
  await shopPage.getByTestId("grid-detail").getByRole("link", { name: "Build a quote" }).click();
  await expect(shopPage.getByRole("heading", { name: "Build a quote", level: 1 })).toBeVisible();
  await shopPage.getByLabel("Number of boxes").fill("30");
  for (const [slot, sku] of Object.entries({ notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "ORGANIZER-DESK", card: "CARD-BRANDED", packaging: "PACK-BOX" })) {
    await shopPage.locator(`input[name="slot-${slot}"][value="${sku}"]`).check();
  }
  await check("shop: Build a quote", shopPage, shopPage.getByRole("button", { name: "Send price to the customer" }));
  await shopPage.getByRole("button", { name: "Send price to the customer" }).click();
  await expect(shopPage.getByRole("status", { name: "Price sent" })).toContainText("$1,080.00 for 30 boxes");
  await shopContext.close();

  await page.goto(orderUrl);
  const price = page.getByRole("region", { name: "Your price" });
  await expect(price).toContainText("$1,080.00");
  await expectStage(page, "Review your price", "Review price");
  await check("order: the shop's price", page, price.getByRole("button", { name: "Accept this price" }));
  await price.getByRole("button", { name: "Accept this price" }).click();
  await expect(price.getByRole("status")).toContainText("You accepted this exact price");
  await expectStage(page, "Approve your order on PayPal", "Approve");
  await expectQueued(db, inquiryId, ["price_ready", "request_handed_over", "request_started"]);

  const port = await replayWithFake(db, inquiryId);
  expect(port.delivered.map((m) => m.subject).sort()).toEqual(sorted([
    "Your request to Demo Gift Boxes (simulated) is saved (sandbox demo)",
    "A customer needs a reply (sandbox demo)",
    "Demo Gift Boxes (simulated) prepared your price (sandbox demo)",
  ]));
  return { inquiryId };
}
