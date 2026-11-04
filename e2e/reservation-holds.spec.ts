import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { createCustomerLink } from "../lib/access/customer-link";
import { authorizeCustomerLink } from "../lib/access/inquiry-reads";
import { acceptQuote } from "../services/quote/accept";
import { createQuoteDraft } from "../services/quote/create-draft";
import { publishQuote } from "../services/quote/publish";
import { beginOperation, settleOperation } from "../services/reservation/operations";
import { reserveForPurchase } from "../services/reservation/reserve";
import { boxTemplate, products, stock } from "../supabase/seed/fixtures";

const needsLocalSupabase = process.env.E2E_LOCAL_SUPABASE !== "1";

test("the holds page is merchant-only: a visitor with no session is sent to the login page", async ({ page }) => {
  await page.goto("/merchant/holds");
  await expect(page).toHaveURL(/\/merchant\/login$/);
  await expect(page.getByRole("heading", { name: "Stock holds" })).toHaveCount(0);
});

test.describe("stock holds (local Supabase)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  type Seller = { merchantId: string; email: string; password: string };
  let a: Seller;
  let b: Seller;

  async function createSeller(label: string): Promise<Seller> {
    const tag = randomBytes(4).toString("hex");
    const email = `e2e-holds-${label}-${tag}@test.invalid`;
    const password = randomUUID();
    const user = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (!user.data.user) throw new Error(`user ${label}: ${user.error?.message}`);
    const merchant = await db
      .from("merchants")
      .insert({ slug: `e2e-holds-${label}-${tag}`, name: `E2E Holds ${label} ${tag}`, owner_user_id: user.data.user.id })
      .select("id")
      .single();
    if (merchant.error) throw new Error(`merchant ${label}: ${merchant.error.message}`);
    const merchantId = merchant.data.id as string;

    const ids = new Map(products.map((p) => [p.id, randomUUID()]));
    const inserted = await db.from("products").insert(products.map((p) => ({ ...p, id: ids.get(p.id)!, merchant_id: merchantId })));
    if (inserted.error) throw new Error(`products: ${inserted.error.message}`);
    const stocked = await db.from("stock").insert(stock.map((s) => ({ ...s, product_id: ids.get(s.product_id)! })));
    if (stocked.error) throw new Error(`stock: ${stocked.error.message}`);
    const rules = await db.from("business_rules").insert([
      { merchant_id: merchantId, key: "box_template", value: boxTemplate },
      { merchant_id: merchantId, key: "production_lead_days", value: { days: 7 } },
    ]);
    if (rules.error) throw new Error(`rules: ${rules.error.message}`);
    return { merchantId, email, password };
  }

  test.beforeAll(async () => {
    db = createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    a = await createSeller("a");
    b = await createSeller("b");
  });

  const secret = () => process.env.E2E_ACCESS_LINK_SECRET!;
  const nowIso = () => new Date().toISOString();
  const ctx = () => ({ now: nowIso(), correlationId: "e2e-holds" });

  /** A real accepted quote of 30 boxes, built through the quote services, with the customer's link. */
  async function acceptedPurchase(seller: Seller) {
    const inquiry = await db.from("inquiries").insert({ merchant_id: seller.merchantId }).select("id").single();
    if (inquiry.error) throw new Error(`inquiry: ${inquiry.error.message}`);
    const inquiryId = inquiry.data.id as string;
    const draft = await createQuoteDraft(
      db,
      {
        inquiryId,
        configuration: {
          boxCount: 30,
          selections: { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "ORGANIZER-DESK", card: "CARD-BRANDED", packaging: "PACK-BOX" },
        },
        requirements: { noFood: true, logoRequired: true, maxPricePerBoxMinor: 3999 },
        requirementVersionId: null,
        conditions: [],
      },
      ctx(),
    );
    if (!draft.ok) throw new Error(`draft: ${draft.code}`);
    const pub = await publishQuote(db, draft.value.quoteId, { kind: "system" }, ctx());
    if (!pub.ok) throw new Error(`publish: ${pub.code}`);

    const link = createCustomerLink({ inquiryId, version: 1, expiresAt: new Date(Date.now() + 60 * 60 * 1000), secret: secret() });
    const access = await authorizeCustomerLink(db, link, { secret: secret() });
    if (!access.ok) throw new Error("link");
    const accepted = await acceptQuote(db, access.inquiry.id, draft.value.quoteId, pub.value.hash, ctx());
    if (!accepted.ok) throw new Error(`accept: ${accepted.code}`);
    return { inquiryId, link, purchaseId: accepted.value.purchaseId };
  }

  async function reserve(purchaseId: string, now = nowIso()) {
    const r = await reserveForPurchase(db, purchaseId, { now, correlationId: "e2e-holds" });
    if (!r.ok) throw new Error(`reserve: ${r.code}`);
    return r.value.reservationId;
  }

  async function signIn(page: Page, seller: Seller) {
    await page.goto("/merchant/login");
    await page.getByLabel("Email").fill(seller.email);
    await page.getByLabel("Password").fill(seller.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/merchant$/);
  }

  const articleFor = (page: Page, inquiryId: string) => page.getByRole("article", { name: new RegExp(inquiryId.slice(0, 8)) });

  test("the customer sees how long the items are held, then that they are reserved once payment is under way", async ({ page }) => {
    const p = await acceptedPurchase(a);
    const reservationId = await reserve(p.purchaseId);

    await page.goto(`/o/${p.link}`);
    const card = page.getByRole("region", { name: "Your price" });
    await expect(card.getByRole("status")).toContainText("You accepted this exact price");
    await expect(card).toContainText(/Your items are held until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\./);

    await beginOperation(db, reservationId, "authorize", ctx());
    await settleOperation(db, reservationId, "AUTHORIZED", ctx());
    await page.reload();
    await expect(page.getByRole("region", { name: "Your price" })).toContainText("Your items are reserved for you.");
    await expect(page.getByText(/held until/)).toHaveCount(0);
  });

  test("a hold that has run out says so, without waiting for the sweep", async ({ page }) => {
    const p = await acceptedPurchase(a);
    await reserve(p.purchaseId, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());

    await page.goto(`/o/${p.link}`);
    await expect(page.getByRole("region", { name: "Your price" })).toContainText("The hold on your items has ended");
    await expect(page.getByText(/held until/)).toHaveCount(0);
  });

  test("an accepted quote with no hold yet shows no hold line at all", async ({ page }) => {
    const p = await acceptedPurchase(a);
    await page.goto(`/o/${p.link}`);
    const card = page.getByRole("region", { name: "Your price" });
    await expect(card.getByRole("status")).toContainText("You accepted this exact price");
    await expect(card).not.toContainText(/held until|reserved for you|hold on your items/);
  });

  test("the merchant sees their holds and the ones needing attention, and nobody else's", async ({ page }) => {
    const plain = await acceptedPurchase(a);
    await reserve(plain.purchaseId);

    const stuck = await acceptedPurchase(a);
    const stuckReservation = await reserve(stuck.purchaseId);
    await beginOperation(db, stuckReservation, "authorize", ctx());
    await settleOperation(db, stuckReservation, "UNKNOWN", ctx(), { note: "timeout after 30s" });

    const others = await acceptedPurchase(b);
    await reserve(others.purchaseId);

    await signIn(page, a);
    await page.getByRole("link", { name: "Stock holds" }).click();
    await expect(page).toHaveURL(/\/merchant\/holds$/);
    await expect(page.getByRole("heading", { name: "Stock holds", level: 1 })).toBeVisible();

    const plainCard = articleFor(page, plain.inquiryId);
    await expect(plainCard).toContainText(/Held until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    await expect(plainCard).toContainText("30 × A5 notebook (NOTEBOOK-A5)");
    await expect(plainCard).toContainText("30 × Desk organizer (ORGANIZER-DESK)");

    const attention = page.getByRole("region", { name: "Needs attention" });
    await expect(attention.getByRole("article", { name: new RegExp(stuck.inquiryId.slice(0, 8)) })).toContainText("timeout after 30s");
    await expect(attention.getByRole("article", { name: new RegExp(plain.inquiryId.slice(0, 8)) })).toHaveCount(0);

    await expect(articleFor(page, others.inquiryId)).toHaveCount(0);
    // Read-only: nothing to submit or type into on this page.
    await expect(page.locator("main input:visible, main textarea:visible, main select:visible, main form:visible")).toHaveCount(0);
  });
});
