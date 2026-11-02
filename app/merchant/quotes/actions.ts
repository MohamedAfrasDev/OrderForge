"use server";

import { refresh } from "next/cache";
import { requireMerchant } from "@/lib/access/require-merchant";
import { newCorrelationId } from "@/lib/correlation";
import { createAdminClient } from "@/lib/supabase/admin";
import { merchantFailureMessage } from "@/services/quote/merchant-messages";
import { publishQuote, withdrawQuote } from "@/services/quote/publish";

export type ReviewState = { status: "idle" } | { status: "error"; message: string } | { status: "done"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

// Server actions are public endpoints, so each one verifies the merchant session first, before reading any field.
// The services then refuse (as NOT_FOUND) any quote that belongs to another merchant.

export async function publishDraftAction(_previous: ReviewState, formData: FormData): Promise<ReviewState> {
  const { user, merchant } = await requireMerchant();
  const quoteId = field(formData, "quoteId");
  if (!UUID.test(quoteId)) return { status: "error", message: merchantFailureMessage("NOT_FOUND") };

  const result = await publishQuote(
    createAdminClient(),
    quoteId,
    { kind: "merchant", userId: user.id, merchantId: merchant.id },
    { now: new Date().toISOString(), correlationId: newCorrelationId(), approvalText: field(formData, "wording") },
  );
  refresh();
  return result.ok ? { status: "done", message: "Published. The customer can now see and accept it." } : { status: "error", message: merchantFailureMessage(result.code) };
}

export async function withdrawDraftAction(_previous: ReviewState, formData: FormData): Promise<ReviewState> {
  const { user, merchant } = await requireMerchant();
  const quoteId = field(formData, "quoteId");
  if (!UUID.test(quoteId)) return { status: "error", message: merchantFailureMessage("NOT_FOUND") };

  const result = await withdrawQuote(
    createAdminClient(),
    quoteId,
    { kind: "merchant", userId: user.id, merchantId: merchant.id },
    field(formData, "reason"),
    { now: new Date().toISOString(), correlationId: newCorrelationId() },
  );
  refresh();
  return result.ok ? { status: "done", message: "Withdrawn." } : { status: "error", message: merchantFailureMessage(result.code) };
}
