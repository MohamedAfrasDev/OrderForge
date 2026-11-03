"use server";

import { refresh } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { authorizeCustomerToken } from "@/lib/access/customer-session";
import { newCorrelationId } from "@/lib/correlation";
import { getServerEnv } from "@/lib/env";
import { createPaymentDeps } from "@/lib/payments/wiring";
import { createAdminClient } from "@/lib/supabase/admin";
import { startCheckout } from "@/services/payments/checkout";
import { noticeForCode } from "@/services/payments/customer-messages";
import { purchaseIdForCustomer } from "@/services/payments/read";
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

/**
 * "Pay with PayPal". The customer's link is verified here, the purchase is the one behind their accepted quote (read
 * from the database, never from the browser), and the amount is the accepted quote's total. Sends the customer to PayPal.
 */
export async function payWithPayPalAction(token: string): Promise<void> {
  const access = await authorizeCustomerToken(token);
  if (!access.ok) notFound();

  const db = createAdminClient();
  const purchaseId = await purchaseIdForCustomer(db, access.inquiry.id);
  if (!purchaseId) redirect(`/o/${token}?payment=UNAVAILABLE`);

  const returnUrl = new URL(`/o/${token}/return`, getServerEnv().APP_BASE_URL).toString();
  const result = await startCheckout(db, createPaymentDeps(), access.inquiry.id, purchaseId, { returnUrl }, { now: new Date().toISOString(), correlationId: newCorrelationId() });
  if (!result.ok) redirect(`/o/${token}?payment=${noticeForCode(result.code)}`);

  if (result.value.approveUrl) redirect(result.value.approveUrl);
  // Already approved at PayPal: finish through the same return step.
  const attempt = await db.from("payment_attempts").select("paypal_order_id").eq("id", result.value.attemptId).single();
  const orderId = attempt.data?.paypal_order_id as string | undefined;
  redirect(orderId ? `/o/${token}/return?token=${encodeURIComponent(orderId)}` : `/o/${token}`);
}
