// Builds genuine accepted quotes through the real quote services (draft, publish, accept), for tests of later modules.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createCustomerLink } from "@/lib/access/customer-link";
import { authorizeCustomerLink, type VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { acceptQuote } from "@/services/quote/accept";
import { createQuoteDraft } from "@/services/quote/create-draft";
import { publishQuote } from "@/services/quote/publish";
import { boxTemplate, products as fixtureProducts, stock as fixtureStock } from "../../supabase/seed/fixtures";
import { must, unique } from "./helpers";
import { trackProducts } from "./reservation-helpers";

export const SECRET = "db-test-secret-with-enough-length";
export const QUOTE_NOW = "2026-11-03T10:00:00.000Z";
const quoteCtx = { now: QUOTE_NOW, correlationId: "corr-accepted-purchase" };
const requirements = { noFood: true, logoRequired: true, maxPricePerBoxMinor: 3999 };

export type Merchant = { merchantId: string; product: Record<string, string> };

/** A merchant of its own with the demo catalog and stock, so tests never share inventory. */
export async function freshMerchant(db: SupabaseClient): Promise<Merchant> {
  const merchant = must(await db.from("merchants").insert({ slug: unique("pay"), name: "Payments test merchant" }).select("id").single(), "merchant");
  const merchantId = merchant.id as string;
  const ids = new Map(fixtureProducts.map((p) => [p.id, randomUUID()]));
  must(await db.from("products").insert(fixtureProducts.map((p) => ({ ...p, id: ids.get(p.id)!, merchant_id: merchantId }))), "products");
  must(await db.from("stock").insert(fixtureStock.map((s) => ({ ...s, product_id: ids.get(s.product_id)! }))), "stock");
  must(
    await db.from("business_rules").insert([
      { merchant_id: merchantId, key: "box_template", value: boxTemplate },
      { merchant_id: merchantId, key: "production_lead_days", value: { days: 7 } },
    ]),
    "rules",
  );
  trackProducts(ids.values());
  return { merchantId, product: Object.fromEntries(fixtureProducts.map((p) => [p.sku, ids.get(p.id)!])) };
}

export const defaultSelections = (gift = "ORGANIZER-DESK") => ({ notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift, card: "CARD-BRANDED", packaging: "PACK-BOX" });

export async function verifiedFor(db: SupabaseClient, inquiryId: string): Promise<VerifiedInquiryId> {
  const token = createCustomerLink({ inquiryId, version: 1, expiresAt: new Date("2030-01-01T00:00:00Z"), secret: SECRET });
  const access = await authorizeCustomerLink(db, token, { secret: SECRET, now: new Date(QUOTE_NOW) });
  if (!access.ok) throw new Error("expected a valid link");
  return access.inquiry.id;
}

export type AcceptedPurchase = { inquiryId: string; quoteId: string; purchaseId: string; approvalId: string; who: VerifiedInquiryId; quoteHash: string };

/** A real accepted quote of `boxCount` boxes (default 30, which is $1,080.00 with the organizer). */
export async function acceptedPurchase(
  db: SupabaseClient,
  m: Merchant,
  opts: { boxCount?: number; conditions?: unknown[] } = {},
): Promise<AcceptedPurchase> {
  const inquiry = must(await db.from("inquiries").insert({ merchant_id: m.merchantId }).select("id").single(), "inquiry");
  const inquiryId = inquiry.id as string;
  const draft = await createQuoteDraft(
    db,
    {
      inquiryId,
      configuration: { boxCount: opts.boxCount ?? 30, selections: defaultSelections() },
      requirements,
      requirementVersionId: null,
      conditions: opts.conditions ?? [],
    },
    quoteCtx,
  );
  if (!draft.ok) throw new Error(`draft: ${draft.code}`);
  const pub = await publishQuote(db, draft.value.quoteId, { kind: "system" }, quoteCtx);
  if (!pub.ok) throw new Error(`publish: ${pub.code}`);
  const who = await verifiedFor(db, inquiryId);
  const accepted = await acceptQuote(db, who, draft.value.quoteId, pub.value.hash, quoteCtx);
  if (!accepted.ok) throw new Error(`accept: ${accepted.code}`);
  return { inquiryId, quoteId: draft.value.quoteId, purchaseId: accepted.value.purchaseId, approvalId: accepted.value.approvalId, who, quoteHash: pub.value.hash };
}
