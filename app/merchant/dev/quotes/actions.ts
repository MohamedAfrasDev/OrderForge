"use server";

import { refresh } from "next/cache";
import { createCustomerLink } from "@/lib/access/customer-link";
import { requireMerchant } from "@/lib/access/require-merchant";
import { newCorrelationId } from "@/lib/correlation";
import { getServerEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { createQuoteDraft } from "@/services/quote/create-draft";
import { publishQuote } from "@/services/quote/publish";

export type DemoState = { message: string; customerPath?: string } | null;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stand-in for the intake step until `ai-intake` exists: makes a demo inquiry with a 30-box quote for the signed-in
 * merchant. "held" carries an unsupported customization, so it waits in the review queue; "published" publishes at
 * once (as the system would) and returns the customer's link. Merchant-only: the session is verified first.
 */
export async function createDemoQuoteAction(_previous: DemoState, formData: FormData): Promise<DemoState> {
  const { merchant } = await requireMerchant();
  const intent = String(formData.get("intent") ?? "");
  if (intent !== "held" && intent !== "published") return { message: "Unknown action." };

  const db = createAdminClient();
  const ctx = { now: new Date().toISOString(), correlationId: newCorrelationId() };

  const inquiry = await db.from("inquiries").insert({ merchant_id: merchant.id }).select("id").single();
  if (inquiry.error) throw new Error(`demo inquiry: ${inquiry.error.message}`);
  const inquiryId = inquiry.data.id as string;
  await db.from("messages").insert({
    inquiry_id: inquiryId,
    role: "customer",
    body: "Demo request: 30 welcome boxes with notebooks, no food, our logo, under $40 per box.",
  });

  const conditions =
    intent === "held"
      ? [{ code: "UNSUPPORTED_CUSTOMIZATION", text: "Gold foil on the lid (a custom request)." }]
      : [{ code: "PRODUCTION_SLOT_CONFIRMATION", text: "Production slot to be confirmed by the merchant." }];

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
    ctx,
  );
  if (!draft.ok) {
    return { message: `The demo quote could not be created (${draft.code}). Does this merchant have the demo catalog? Run the seed first.` };
  }

  if (intent === "published") {
    const published = await publishQuote(db, draft.value.quoteId, { kind: "system" }, ctx);
    if (!published.ok) return { message: `The demo quote could not be published (${published.code}).` };
  }

  const token = createCustomerLink({
    inquiryId,
    version: 1,
    expiresAt: new Date(Date.now() + WEEK_MS),
    secret: getServerEnv().ACCESS_LINK_SECRET,
  });
  refresh();
  return {
    message: intent === "held" ? "Demo draft created. It is waiting in the review queue." : "Demo quote published. Open the customer link to see it.",
    customerPath: `/o/${token}`,
  };
}
