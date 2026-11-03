// Fixtures for the turn tests: a merchant with the demo catalog, a started inquiry, and scripted model answers in the shape the
// real model returns. They are written by hand, not recorded: real recordings arrive with the evaluation set (T10), and the
// tests that use these say "scripted", never "recorded".
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { startInquiry } from "@/services/intake/start";
import { boxTemplate, products as fixtureProducts, stock as fixtureStock } from "../../supabase/seed/fixtures";
import { must, unique } from "./helpers";
import { ctx, deps, verifiedFor } from "./intake-helpers";
import { trackProducts } from "./reservation-helpers";

/** A merchant of its own with the demo catalog and stock (24 steel bottles), so tests never share inventory. */
export async function catalogMerchant(db: SupabaseClient): Promise<{ merchantId: string; slug: string; productId: Record<string, string> }> {
  const slug = unique("ik").toLowerCase();
  const merchant = must(await db.from("merchants").insert({ slug, name: "Intake turn merchant" }).select("id").single(), "merchant");
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
  return { merchantId, slug, productId: Object.fromEntries(fixtureProducts.map((p) => [p.sku, ids.get(p.id)!])) };
}

/** An inquiry started with `text`; `who` is the verified id the customer entry points need. */
export async function begin(db: SupabaseClient, slug: string, text: string) {
  const out = await startInquiry(db, deps, slug, text, ctx);
  if (!out.ok) throw new Error(`start: ${out.code}`);
  const inquiryId = out.value.inquiryId;
  const first = must(await db.from("messages").select("id").eq("inquiry_id", inquiryId).limit(1).single(), "first message");
  return { inquiryId, who: await verifiedFor(db, inquiryId), messageId: first.id as string };
}

/** A later customer message, stored the way the app stores it (one second after `ctx.now` per call so order is fixed). */
let tick = 0;
export async function say(db: SupabaseClient, inquiryId: string, text: string): Promise<string> {
  tick += 1;
  const row = must(
    await db.from("messages").insert({ inquiry_id: inquiryId, role: "customer", body: text, created_at: new Date(Date.parse(ctx.now) + tick * 1000).toISOString() }).select("id").single(),
    "message",
  );
  return row.id as string;
}

const confirmed = <T>(value: T) => ({ value, status: "confirmed" as const });

/** Step A of the demo path as the model reads it: 20 boxes, no food, a logo, under $40 a box, notebooks preferred. */
export const readA = {
  boxCount: confirmed(20),
  noFood: confirmed(true),
  logoRequired: confirmed(true),
  maxPricePerBoxMinor: confirmed(4000),
  preferences: confirmed(["notebooks"]),
};

export const BOTTLE_BOX = { notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift: "BOTTLE-STEEL", card: "CARD-BRANDED", packaging: "PACK-BOX" };
export const ORGANIZER_BOX = { ...BOTTLE_BOX, gift: "ORGANIZER-DESK" };

export const kindsOf = (requests: Array<{ kind: string }>) => requests.map((r) => r.kind);
