// Shared set-up for the payments specs. The app under test talks to the LOCAL FAKE PayPal (mocked evidence).
import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";
import { createCustomerLink } from "../lib/access/customer-link";
import { authorizeCustomerLink } from "../lib/access/inquiry-reads";
import { createPayPalClient } from "../lib/paypal/client";
import { completeApproval, startCheckout } from "../services/payments/checkout";
import { acceptQuote } from "../services/quote/accept";
import { createQuoteDraft } from "../services/quote/create-draft";
import { publishQuote } from "../services/quote/publish";
import { boxTemplate, products, stock } from "../supabase/seed/fixtures";

export const needsLocalSupabase = process.env.E2E_LOCAL_SUPABASE !== "1";

export type Seller = { merchantId: string; email: string; password: string };

export function adminClient(): SupabaseClient {
  return createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SERVICE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function createSeller(db: SupabaseClient, label: string): Promise<Seller> {
  const tag = randomBytes(4).toString("hex");
  const email = `e2e-pay-${label}-${tag}@test.invalid`;
  const password = randomUUID();
  const user = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (!user.data.user) throw new Error(`user ${label}: ${user.error?.message}`);
  const merchant = await db
    .from("merchants")
    .insert({ slug: `e2e-pay-${label}-${tag}`, name: `E2E Pay ${label} ${tag}`, owner_user_id: user.data.user.id })
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

const secret = () => process.env.E2E_ACCESS_LINK_SECRET!;
const ctx = () => ({ now: new Date().toISOString(), correlationId: "e2e-payments" });

export const paypal = () =>
  createPayPalClient({ env: "sandbox", clientId: "e2e-client-id", clientSecret: "e2e-client-secret-0000000000", baseUrl: process.env.E2E_FAKE_PAYPAL_URL! });
export const paymentDeps = () => ({ paypal: paypal(), evidence: "mocked" as const });

/** The sandbox buyer's approval click, on the fake only. */
export async function approveAtFake(orderId: string): Promise<void> {
  const response = await fetch(`${process.env.E2E_FAKE_PAYPAL_URL}/__fake/approve/${orderId}`, { method: "POST" });
  if (!response.ok) throw new Error(`fake approve: ${response.status}`);
}

export type Accepted = { inquiryId: string; link: string; purchaseId: string; quoteId: string };

/** A real accepted quote of 30 boxes (USD 1,080.00), built through the quote services, with the customer's link. */
export async function acceptedPurchase(db: SupabaseClient, seller: Seller, conditions: unknown[] = []): Promise<Accepted> {
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
      conditions,
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
  return { inquiryId, link, purchaseId: accepted.value.purchaseId, quoteId: draft.value.quoteId };
}

/** An accepted quote whose payment is AUTHORIZED at the fake and waiting for the merchant (demo steps A and B done). */
export async function authorizedPurchase(db: SupabaseClient, seller: Seller, conditions: unknown[] = []): Promise<Accepted> {
  const p = await acceptedPurchase(db, seller, conditions);
  const access = await authorizeCustomerLink(db, p.link, { secret: secret() });
  if (!access.ok) throw new Error("link");
  const started = await startCheckout(db, paymentDeps(), access.inquiry.id, p.purchaseId, { returnUrl: "http://localhost:3100/o/x/return" }, ctx());
  if (!started.ok) throw new Error(`startCheckout: ${started.code}`);
  const attempt = await db.from("payment_attempts").select("paypal_order_id").eq("purchase_id", p.purchaseId).single();
  const orderId = attempt.data!.paypal_order_id as string;
  await approveAtFake(orderId);
  const done = await completeApproval(db, paymentDeps(), access.inquiry.id, orderId, ctx());
  if (!done.ok) throw new Error(`completeApproval: ${done.code}`);
  return p;
}

export async function signIn(page: Page, seller: Seller): Promise<void> {
  await page.goto("/merchant/login");
  await page.getByLabel("Email").fill(seller.email);
  await page.getByLabel("Password").fill(seller.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/merchant$/);
}

export async function attemptOf(db: SupabaseClient, purchaseId: string) {
  const found = await db.from("payment_attempts").select("id, state, paypal_order_id").eq("purchase_id", purchaseId).order("created_at", { ascending: false }).limit(1).single();
  if (found.error) throw new Error(`attempt: ${found.error.message}`);
  return found.data as { id: string; state: string; paypal_order_id: string | null };
}
