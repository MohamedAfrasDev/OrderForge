import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { createCustomerLink } from "../lib/access/customer-link";
import { createQuoteDraft } from "../services/quote/create-draft";
import { boxTemplate, products, stock } from "../supabase/seed/fixtures";

const needsLocalSupabase = process.env.E2E_LOCAL_SUPABASE !== "1";

test("the review queue is merchant-only: a visitor with no session is sent to the login page", async ({ page }) => {
  await page.goto("/merchant/quotes");
  await expect(page).toHaveURL(/\/merchant\/login$/);
  await expect(page.getByRole("heading", { name: "Quote review" })).toHaveCount(0);
});

test.describe("quote review queue (local Supabase)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  type Seller = { merchantId: string; email: string; password: string };
  let a: Seller;
  let b: Seller;

  async function createSeller(label: string): Promise<Seller> {
    const tag = randomBytes(4).toString("hex");
    const email = `e2e-review-${label}-${tag}@test.invalid`;
    const password = randomUUID();
    const user = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (!user.data.user) throw new Error(`user ${label}: ${user.error?.message}`);
    const merchant = await db
      .from("merchants")
      .insert({ slug: `e2e-review-${label}-${tag}`, name: `E2E Review ${label} ${tag}`, owner_user_id: user.data.user.id })
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

  async function signIn(page: Page, seller: Seller) {
    await page.goto("/merchant/login");
    await page.getByLabel("Email").fill(seller.email);
    await page.getByLabel("Password").fill(seller.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/merchant$/);
  }

  async function heldDraft(seller: Seller, text = "Gold foil lid.") {
    const inquiry = await db.from("inquiries").insert({ merchant_id: seller.merchantId }).select("id").single();
    if (inquiry.error) throw new Error(`inquiry: ${inquiry.error.message}`);
    const inquiryId = inquiry.data.id as string;
    const r = await createQuoteDraft(
      db,
      {
        inquiryId,
        configuration: {
          boxCount: 30,
          selections: { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "ORGANIZER-DESK", card: "CARD-BRANDED", packaging: "PACK-BOX" },
        },
        requirements: { noFood: true, logoRequired: true, maxPricePerBoxMinor: 3999 },
        requirementVersionId: null,
        conditions: [{ code: "UNSUPPORTED_CUSTOMIZATION", text: text }],
      },
      { now: new Date().toISOString(), correlationId: "e2e-review" },
    );
    if (!r.ok) throw new Error(`draft: ${r.code}`);
    return { inquiryId, quoteId: r.value.quoteId };
  }

  const articleFor = (page: Page, inquiryId: string) => page.getByRole("article", { name: new RegExp(inquiryId.slice(0, 8)) });
  const statusOf = async (quoteId: string) => (await db.from("quote_versions").select("status").eq("id", quoteId).single()).data?.status;

  test("the merchant approves a held draft in their own words and the customer sees it", async ({ page }) => {
    const draft = await heldDraft(a);
    await signIn(page, a);
    await page.getByRole("link", { name: "Quote review" }).click();
    await expect(page).toHaveURL(/\/merchant\/quotes$/);

    const card = articleFor(page, draft.inquiryId);
    await expect(card).toContainText("Needs your decision");
    await expect(card).toContainText("Gold foil lid.");
    await expect(card).toContainText("30 boxes at $36.00 per box, $1,080.00 total");

    await card.getByLabel(/Your wording for the customer/).fill("We can foil the lid for this order.");
    await card.getByRole("button", { name: "Approve and publish" }).click();
    await expect(articleFor(page, draft.inquiryId)).toHaveCount(0);
    expect(await statusOf(draft.quoteId)).toBe("PUBLISHED");

    const link = createCustomerLink({
      inquiryId: draft.inquiryId,
      version: 1,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      secret: process.env.E2E_ACCESS_LINK_SECRET!,
    });
    await page.goto(`/o/${link}`);
    const quote = page.getByRole("region", { name: "Quote" });
    await expect(quote).toContainText("We can foil the lid for this order.");
    await expect(quote).not.toContainText("Gold foil lid.");
    await expect(quote.getByRole("button", { name: "Accept this exact quote" })).toBeVisible();
  });

  test("blank wording is refused and the draft stays", async ({ page }) => {
    const draft = await heldDraft(a);
    await signIn(page, a);
    await page.goto("/merchant/quotes");
    const card = articleFor(page, draft.inquiryId);
    await card.getByLabel(/Your wording for the customer/).fill("   ");
    await card.getByRole("button", { name: "Approve and publish" }).click();
    await expect(card.getByRole("alert")).toContainText("Write the wording");
    expect(await statusOf(draft.quoteId)).toBe("DRAFT");
  });

  test("the merchant can withdraw a draft with a reason", async ({ page }) => {
    const draft = await heldDraft(a);
    await signIn(page, a);
    await page.goto("/merchant/quotes");
    const card = articleFor(page, draft.inquiryId);

    await card.getByRole("button", { name: "Withdraw quote" }).click();
    await expect(card.getByRole("alert")).toContainText("a reason");
    expect(await statusOf(draft.quoteId)).toBe("DRAFT");

    await card.getByLabel("Reason for withdrawing").fill("We cannot do gold foil.");
    await card.getByRole("button", { name: "Withdraw quote" }).click();
    await expect(articleFor(page, draft.inquiryId)).toHaveCount(0);
    expect(await statusOf(draft.quoteId)).toBe("WITHDRAWN");
  });

  test("another merchant's drafts are not shown, and cannot be published by editing the form", async ({ page }) => {
    const mine = await heldDraft(a);
    const theirs = await heldDraft(b, "Secret request of merchant B.");
    await signIn(page, a);
    await page.goto("/merchant/quotes");

    await expect(articleFor(page, mine.inquiryId)).toBeVisible();
    await expect(articleFor(page, theirs.inquiryId)).toHaveCount(0);
    await expect(page.getByText("Secret request of merchant B.")).toHaveCount(0);

    // Wait for hydration first: React would otherwise overwrite the edited value with the real one.
    await page.waitForLoadState("networkidle");
    const card = articleFor(page, mine.inquiryId);
    const field = card.locator('input[name="quoteId"]').first();
    await field.evaluate((el, id) => ((el as HTMLInputElement).value = id), theirs.quoteId);
    await expect(field).toHaveValue(theirs.quoteId);
    await card.getByLabel(/Your wording for the customer/).fill("Trying to approve someone else's quote.");
    await card.getByRole("button", { name: "Approve and publish" }).click();

    await expect(card.getByRole("alert")).toContainText("not found");
    expect(await statusOf(theirs.quoteId)).toBe("DRAFT");
    expect(await statusOf(mine.quoteId)).toBe("DRAFT");
  });

  test("the demo page makes a held draft for the queue and a published quote with a customer link", async ({ page }) => {
    await signIn(page, a);
    await page.goto("/merchant/dev/quotes");
    await expect(page.getByRole("heading", { name: "Demo quotes" })).toBeVisible();

    await page.getByRole("button", { name: "Create a draft that needs my decision" }).click();
    await expect(page.getByRole("status").filter({ hasText: "waiting in the review queue" })).toBeVisible();
    await page.getByRole("link", { name: "Go to the review queue" }).click();
    await expect(page.getByText("Gold foil on the lid (a custom request).").first()).toBeVisible();

    await page.goto("/merchant/dev/quotes");
    await page.getByRole("button", { name: "Create a published quote" }).click();
    await page.getByRole("link", { name: "Open the customer link" }).click();
    const quote = page.getByRole("region", { name: "Quote" });
    await expect(quote).toContainText("$1,080.00");
    await expect(quote).toContainText("Production slot to be confirmed by the merchant.");
  });
});
