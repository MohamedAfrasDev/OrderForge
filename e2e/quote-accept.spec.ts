import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { createCustomerLink } from "../lib/access/customer-link";
import { createQuoteDraft } from "../services/quote/create-draft";
import { publishQuote } from "../services/quote/publish";
import { boxTemplate, products, stock } from "../supabase/seed/fixtures";

const needsLocalSupabase = process.env.E2E_LOCAL_SUPABASE !== "1";

test.describe("customer quote card (local Supabase)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  let merchantId: string;

  test.beforeAll(async () => {
    db = createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // A merchant of this spec's own, so it never depends on (or disturbs) the other specs' data.
    const merchant = await db
      .from("merchants")
      .insert({ slug: `e2e-quote-${randomBytes(4).toString("hex")}`, name: "E2E Quote Merchant" })
      .select("id")
      .single();
    if (merchant.error) throw new Error(`merchant: ${merchant.error.message}`);
    merchantId = merchant.data.id as string;

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
  });

  const system = { kind: "system" } as const;
  const requirements = { noFood: true, logoRequired: true, maxPricePerBoxMinor: 3999 };
  const box = (count: number) => ({
    boxCount: count,
    selections: { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "ORGANIZER-DESK", card: "CARD-BRANDED", packaging: "PACK-BOX" },
  });

  async function newInquiry() {
    const row = await db.from("inquiries").insert({ merchant_id: merchantId }).select("id").single();
    if (row.error) throw new Error(`inquiry: ${row.error.message}`);
    const id = row.data.id as string;
    const link = createCustomerLink({
      inquiryId: id,
      version: 1,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      secret: process.env.E2E_ACCESS_LINK_SECRET!,
    });
    return { id, link };
  }

  async function draft(inquiryId: string, boxes = 30, conditions: unknown[] = []) {
    const ctx = { now: new Date().toISOString(), correlationId: "e2e-quote" };
    const r = await createQuoteDraft(db, { inquiryId, configuration: box(boxes), requirements, requirementVersionId: null, conditions }, ctx);
    if (!r.ok) throw new Error(`draft: ${r.code}`);
    return r.value.quoteId;
  }

  async function publish(quoteId: string, now = new Date().toISOString()) {
    const r = await publishQuote(db, quoteId, system, { now, correlationId: "e2e-quote" });
    if (!r.ok) throw new Error(`publish: ${r.code}`);
    return r.value.hash;
  }

  const count = async (table: string, quoteId: string) =>
    (await db.from(table).select("id").eq("quote_version_id", quoteId)).data?.length ?? -1;

  test("shows the exact quote, accepts it once, and stays accepted after a reload", async ({ page }) => {
    const inquiry = await newInquiry();
    const quoteId = await draft(inquiry.id, 30, [{ code: "PRODUCTION_SLOT_CONFIRMATION", text: "Production slot to be confirmed." }]);
    await publish(quoteId);

    await page.goto(`/o/${inquiry.link}`);
    const card = page.getByRole("region", { name: "Quote" });
    await expect(card.getByRole("heading", { name: "Quote version 1" })).toBeVisible();
    await expect(card.getByRole("row", { name: /Desk organizer/ })).toContainText("$14.00");
    await expect(card).toContainText("$36.00");
    await expect(card).toContainText("$1,080.00");
    await expect(card.getByText("Production slot to be confirmed.").first()).toBeVisible();
    await expect(card).toContainText("You are authorizing this exact proposal, subject to the merchant confirming the listed production conditions.");

    await card.getByRole("button", { name: "Accept this exact quote" }).click();
    await expect(card.getByRole("status")).toContainText("You accepted this exact quote");
    await expect(card.getByRole("button", { name: /Accept/ })).toHaveCount(0);
    expect(await count("approvals", quoteId)).toBe(1);
    expect(await count("purchases", quoteId)).toBe(1);

    await page.reload();
    await expect(page.getByRole("region", { name: "Quote" }).getByRole("status")).toContainText("You accepted this exact quote");
    await expect(page.getByRole("button", { name: /Accept/ })).toHaveCount(0);
  });

  test("a stale page cannot accept a replaced quote, and a reload shows the new version", async ({ page }) => {
    const inquiry = await newInquiry();
    const v1 = await draft(inquiry.id, 30);
    await publish(v1);

    await page.goto(`/o/${inquiry.link}`);
    await expect(page.getByRole("heading", { name: "Quote version 1" })).toBeVisible();

    // The merchant publishes a changed quote while the customer still has version 1 open.
    const v2 = await draft(inquiry.id, 31);
    await publish(v2);

    await page.getByRole("button", { name: "Accept this exact quote" }).click();
    await expect(page.getByRole("region", { name: "Quote" }).getByRole("alert")).toContainText("newer version");
    expect(await count("approvals", v1)).toBe(0);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Quote version 2" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Quote" })).toContainText("$1,116.00");
    await expect(page.getByRole("button", { name: "Accept this exact quote" })).toBeVisible();
  });

  test("an expired quote shows no accept button", async ({ page }) => {
    const inquiry = await newInquiry();
    const quoteId = await draft(inquiry.id);
    await publish(quoteId, new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString());

    await page.goto(`/o/${inquiry.link}`);
    await expect(page.getByRole("region", { name: "Quote" })).toContainText("This quote expired");
    await expect(page.getByRole("button", { name: /Accept/ })).toHaveCount(0);
  });

  test("a draft held for merchant review is not shown to the customer", async ({ page }) => {
    const inquiry = await newInquiry();
    await draft(inquiry.id, 30, [{ code: "UNSUPPORTED_CUSTOMIZATION", text: "Gold foil lid." }]);

    await page.goto(`/o/${inquiry.link}`);
    await expect(page.getByRole("heading", { name: "Your request", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Quote" })).toHaveCount(0);
    await expect(page.getByText("Gold foil lid.")).toHaveCount(0);
  });

  test("a customer cannot accept another customer's quote by editing the form", async ({ page }) => {
    const mine = await newInquiry();
    await publish(await draft(mine.id));
    const theirs = await newInquiry();
    const theirQuote = await draft(theirs.id);
    await publish(theirQuote);

    await page.goto(`/o/${mine.link}`);
    // Wait for hydration first: React would otherwise overwrite the edited value with the real one.
    await page.waitForLoadState("networkidle");
    const field = page.locator('input[name="quoteId"]');
    await field.evaluate((el, id) => ((el as HTMLInputElement).value = id), theirQuote);
    await expect(field).toHaveValue(theirQuote);
    await page.getByRole("button", { name: "Accept this exact quote" }).click();

    await expect(page.getByRole("region", { name: "Quote" }).getByRole("alert")).toContainText("not available");
    expect(await count("approvals", theirQuote)).toBe(0);
    const row = await db.from("quote_versions").select("status").eq("id", theirQuote).single();
    expect(row.data?.status).toBe("PUBLISHED");
  });
});
