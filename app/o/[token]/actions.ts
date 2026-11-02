"use server";

import { refresh } from "next/cache";
import { authorizeCustomerToken } from "@/lib/access/customer-session";
import { newCorrelationId } from "@/lib/correlation";
import { createAdminClient } from "@/lib/supabase/admin";
import { acceptQuote } from "@/services/quote/accept";
import { acceptFailureMessage } from "@/services/quote/customer-messages";

export type AcceptState = { status: "idle" } | { status: "error"; message: string } | { status: "done" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

/**
 * The customer accepts the exact quote version and hash shown on the page. The link token is bound to the action
 * and verified here, on the server, every time; the form fields are only a claim about what the customer saw.
 */
export async function acceptQuoteAction(token: string, _previous: AcceptState, formData: FormData): Promise<AcceptState> {
  const access = await authorizeCustomerToken(token);
  if (!access.ok) return { status: "error", message: acceptFailureMessage("NOT_FOUND") };

  const quoteId = formData.get("quoteId");
  const hash = formData.get("hash");
  if (typeof quoteId !== "string" || !UUID.test(quoteId) || typeof hash !== "string" || !HASH.test(hash)) {
    return { status: "error", message: acceptFailureMessage("NOT_FOUND") };
  }

  const result = await acceptQuote(createAdminClient(), access.inquiry.id, quoteId, hash, {
    now: new Date().toISOString(),
    correlationId: newCorrelationId(),
  });
  // Re-render either way: a refusal usually means the page is out of date (replaced, expired, withdrawn).
  refresh();
  return result.ok ? { status: "done" } : { status: "error", message: acceptFailureMessage(result.code) };
}
