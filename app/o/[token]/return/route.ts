import { notFound, redirect } from "next/navigation";
import { authorizeCustomerToken } from "@/lib/access/customer-session";
import { newCorrelationId } from "@/lib/correlation";
import { createPaymentDeps } from "@/lib/payments/wiring";
import { createAdminClient } from "@/lib/supabase/admin";
import { completeApproval } from "@/services/payments/checkout";
import { noticeForCode } from "@/services/payments/customer-messages";

/**
 * Where PayPal sends the customer back. The `token` query value is only an order id: it proves nothing. completeApproval
 * asks PayPal whether the order is really approved before anything happens, and doing this twice is harmless.
 */
export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const access = await authorizeCustomerToken(token);
  if (!access.ok) notFound();

  const orderId = new URL(request.url).searchParams.get("token") ?? "";
  const result = await completeApproval(createAdminClient(), createPaymentDeps(), access.inquiry.id, orderId, {
    now: new Date().toISOString(),
    correlationId: newCorrelationId(),
  });
  redirect(`/o/${token}?payment=${result.ok ? "DONE" : noticeForCode(result.code)}`);
}
