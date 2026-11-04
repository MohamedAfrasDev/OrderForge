"use server";

import { requireMerchant } from "@/lib/access/require-merchant";
import { newCorrelationId } from "@/lib/correlation";
import { format, cents } from "@/lib/money";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildQuoteForInquiry } from "@/services/intake/merchant-quote";

export type BuildState =
  | { status: "idle" }
  | { status: "error"; message: string; blockers?: string[] }
  | { status: "done"; total: string; perBox: string; boxes: number };

// A server action is a public endpoint: the shop's session is verified first, and the service refuses another shop's request as "not found".
// Only a quantity, a product per slot and two yes/no notes come from the browser: there is no field for a price.
// No refresh() here: the page would re-read, find the request already priced, and replace the form (and its "price sent" message) with the "not waiting" view.
export async function buildQuoteAction(_previous: BuildState, formData: FormData): Promise<BuildState> {
  const { user, merchant } = await requireMerchant();
  const selections: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("slot-") && typeof value === "string") selections[key.slice("slot-".length)] = value;
  }
  const raw = formData.get("quantity");
  const quantity = typeof raw === "string" && /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;

  const result = await buildQuoteForInquiry(
    createAdminClient(),
    { userId: user.id, merchantId: merchant.id },
    formData.get("inquiryId"),
    { quantity, selections, notes: { artwork: formData.get("artwork") === "on", productionSlot: formData.get("productionSlot") === "on" } },
    { now: new Date().toISOString(), correlationId: newCorrelationId() },
  );
  if (result.ok) return { status: "done", total: format(cents(result.value.totalMinor)), perBox: format(cents(result.value.perBoxMinor)), boxes: result.value.boxCount };
  switch (result.code) {
    case "CONFIGURATION_BLOCKED":
      return { status: "error", message: "This box cannot be made as chosen. Nothing was sent to the customer.", blockers: result.blockers };
    case "ILLEGAL_STATE":
      return { status: "error", message: "This request is no longer waiting for you, so nothing was sent. It may already have a price." };
    case "NOT_FOUND":
      return { status: "error", message: "We could not find that request." };
    case "INVALID_INPUT":
      return { status: "error", message: "Enter a whole number of boxes and choose a product for every part of the box." };
  }
}
