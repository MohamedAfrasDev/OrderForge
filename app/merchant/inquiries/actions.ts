"use server";

import { refresh } from "next/cache";
import { requireMerchant } from "@/lib/access/require-merchant";
import { newCorrelationId } from "@/lib/correlation";
import { createAdminClient } from "@/lib/supabase/admin";
import { intakeFailureMessage } from "@/services/intake/customer-messages";
import { replyAsMerchant } from "@/services/intake/merchant";

export type ReplyState = { status: "idle" } | { status: "error"; message: string } | { status: "done" };

// Server actions are public endpoints: the merchant session is verified first. The service then refuses (as "not found") an
// inquiry of another merchant and one that is not with the merchant. Only the inquiry id and the text come from the browser.
export async function replyAction(_previous: ReplyState, formData: FormData): Promise<ReplyState> {
  const { user, merchant } = await requireMerchant();
  const result = await replyAsMerchant(createAdminClient(), { userId: user.id, merchantId: merchant.id }, formData.get("inquiryId"), formData.get("body"), {
    now: new Date().toISOString(),
    correlationId: newCorrelationId(),
  });
  refresh();
  return result.ok ? { status: "done" } : { status: "error", message: intakeFailureMessage(result.code) };
}
