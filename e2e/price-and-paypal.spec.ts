// The price as an itemised receipt, what PayPal will and won't do said next to the button, and "Keep this page", in a real browser
// against the LOCAL Supabase stack with the local fake PayPal (mocked).
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { createCustomerLink } from "../lib/access/customer-link";
import { TERMS_SENTENCE } from "../domain/quote";
import { createQuoteDraft } from "../services/quote/create-draft";
import { publishQuote } from "../services/quote/publish";
import { acceptedPurchase, adminClient, createSeller, needsLocalSupabase, type Seller } from "./payments-support";

test.describe("the price, the PayPal box and keep this page (local Supabase, fake PayPal)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  let seller: Seller;

  test.beforeAll(async () => {
    db = adminClient();
    seller = await createSeller(db, "price");
  });

  // A private address per test, so this spec never uses up the shared per-address budget of the others.
  test.beforeEach(async ({ page }) => {
    const a = Math.floor(Math.random() * 250) + 1;
    const b = Math.floor(Math.random() * 250) + 1;
    await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `100.64.${a}.${b}` });
  });

  async function published(conditions: unknown[] = []): Promise<string> {
    const inquiry = await db.from("inquiries").insert({ merchant_id: seller.merchantId }).select("id").single();
    if (inquiry.error) throw new Error(inquiry.error.message);
    const inquiryId = inquiry.data.id as string;
    const ctx = { now: new Date().toISOString(), correlationId: `e2e-price-${randomBytes(3).toString("hex")}` };
    const draft = await createQuoteDraft(
      db,
      {
        inquiryId,
        configuration: { boxCount: 30, selections: { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "ORGANIZER-DESK", card: "CARD-BRANDED", packaging: "PACK-BOX" } },
        requirements: { noFood: true, logoRequired: true, maxPricePerBoxMinor: 3999 },
        requirementVersionId: null,
        conditions,
      },
      ctx,
    );
    if (!draft.ok) throw new Error(`draft: ${draft.code}`);
    const out = await publishQuote(db, draft.value.quoteId, { kind: "system" }, ctx);
    if (!out.ok) throw new Error(`publish: ${out.code}`);
    return createCustomerLink({ inquiryId, version: 1, expiresAt: new Date(Date.now() + 3_600_000), secret: process.env.E2E_ACCESS_LINK_SECRET! });
  }

  test("the price is an itemised receipt, and the words the customer accepts are shown exactly as they were hashed", async ({ page }) => {
    await page.goto(`/o/${await published([{ code: "ARTWORK_ACCEPTANCE", text: "Artwork to be accepted." }])}`);
    const price = page.getByRole("region", { name: "Your price" });
    await expect(price.getByRole("heading", { name: "Your price", level: 2, exact: true })).toBeVisible();
    for (const [item, each] of [["A5 notebook", "$12.00"], ["Black gel pen", "$3.00"], ["Desk organizer", "$14.00"], ["Branded welcome card", "$2.00"], ["Gift box packaging", "$5.00"]]) {
      await expect(price.getByRole("row", { name: new RegExp(item!) })).toContainText(each!);
    }
    await expect(price.getByText("Price per box")).toBeVisible();
    await expect(price.locator("dd").filter({ hasText: "$36.00" })).toBeVisible();
    await expect(price.locator("dd").filter({ hasText: "$1,080.00" })).toBeVisible();
    await expect(price.getByText(/You can accept this price until/)).toBeVisible();
    await expect(price.getByRole("heading", { name: "Things to know about this price" })).toBeVisible();
    await expect(price.getByText("Artwork to be accepted.").first()).toBeVisible();

    // Unchanged: the terms the customer agrees to, word for word.
    await expect(price.locator("[data-terms]")).toContainText(TERMS_SENTENCE);
    await expect(price.locator("[data-terms]")).toContainText("Quote version 1: 30 boxes at $36.00 per box, $1,080.00 total (USD).");
    await expect(price.getByRole("button", { name: "Accept this price" })).toBeVisible();
  });

  test("before paying, the PayPal box says what is held, who decides, and what happens on yes and no", async ({ page }) => {
    const accepted = await acceptedPurchase(db, seller);
    await page.goto(`/o/${accepted.link}`);
    const payment = page.getByRole("region", { name: "Payment" });
    await expect(payment).toContainText("You won't be charged yet.");
    await expect(payment).toContainText("PayPal sets aside $1,080.00.");
    await expect(payment).toContainText("The shop reviews your order and, only if they accept, you're charged.");
    await expect(payment).toContainText("If they say no, the hold disappears.");
    await expect(payment.getByRole("button", { name: "Approve on PayPal" })).toBeVisible();
    await expect(payment.getByRole("button")).toHaveCount(1); // one main action
  });

  test("keep this page: the link, copy it, and an email to themselves; nothing is sent by the server", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const link = await published();
    await page.goto(`/o/${link}?payment=NOT_APPROVED`);
    const keep = page.getByRole("region", { name: "Keep this page" });
    await expect(keep).toContainText("This link is the only way back to your order, and anyone who has it can open it.");

    // The link is the page's own address, without the notice that was after it.
    const shown = await keep.getByLabel("Link to your order").inputValue();
    expect(shown).toBe(new URL(`/o/${link}`, page.url()).toString());

    const requests: string[] = [];
    page.on("request", (r) => requests.push(`${r.method()} ${r.url()}`));
    await keep.getByRole("button", { name: "Copy link" }).click();
    await expect(keep.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);

    const href = await keep.getByRole("link", { name: "Email it to me" }).getAttribute("href");
    expect(href).toMatch(/^mailto:\?subject=/);
    const parts = new URL(href!);
    expect(parts.searchParams.get("body")).toContain(shown);
    expect(parts.searchParams.get("subject")).toMatch(/^Your order with /);
    expect(requests.filter((r) => !r.startsWith("GET"))).toEqual([]); // copying and the mail link send nothing
  });

  test("keep this page says the link was emailed only when it was, and never shows the address", async ({ page }) => {
    const link = await published();
    const inquiryId = JSON.parse(Buffer.from(link.split(".")[0]!, "base64url").toString()).i as string;
    const keep = page.getByRole("region", { name: "Keep this page" });

    await page.goto(`/o/${link}`);
    await expect(keep).toBeVisible();
    await expect(page.getByTestId("link-emailed")).toHaveCount(0); // no address, nothing to say

    await db.from("inquiries").update({ customer_email: "sam.private@example.com" }).eq("id", inquiryId);
    const row = { inquiry_id: inquiryId, recipient: "customer", kind: "request_started", dedupe_key: `request_started:${inquiryId}` };
    await db.from("notifications").insert({ ...row, status: "SKIPPED" });
    await page.reload();
    await expect(page.getByTestId("link-emailed")).toHaveCount(0); // skipped (no provider): no promise

    // (The "on its way" wording is covered in the database test: here the server's own background pass would turn a pending row into a skipped one before the page loads.)
    await db.from("notifications").update({ status: "SENT", sent_at: new Date().toISOString() }).eq("dedupe_key", row.dedupe_key);
    await page.reload();
    await expect(page.getByTestId("link-emailed")).toHaveText("We also emailed this link to the address you gave.");
    await expect(page.locator("body")).not.toContainText("sam.private@example.com");
  });

  async function stayVisible(page: Page, name: string) {
    await expect(page.getByRole("region", { name })).toBeVisible();
  }

  test("keep this page is on the page at every stage the order room shows", async ({ page }) => {
    await page.goto(`/o/${await published()}`);
    await stayVisible(page, "Keep this page");
    const accepted = await acceptedPurchase(db, seller);
    await page.goto(`/o/${accepted.link}`);
    await stayVisible(page, "Keep this page");
  });
});
