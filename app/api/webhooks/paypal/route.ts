import { getServerEnv } from "@/lib/env";
import { createPayPalClient, type PayPalClient } from "@/lib/paypal/client";
import { createPaymentDeps } from "@/lib/payments/wiring";
import { handlePayPalWebhook } from "@/lib/paypal/webhook-handler";
import { recordPaymentEvent } from "@/lib/paypal/webhook-store";
import { createAdminClient } from "@/lib/supabase/admin";
import { newCorrelationId } from "@/lib/correlation";
import { applyWebhookEvent } from "@/services/payments/webhook";

// Kept across requests so the PayPal access token is cached.
let client: PayPalClient | undefined;

export async function POST(request: Request) {
  const env = getServerEnv();
  client ??= createPayPalClient({
    env: "sandbox",
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
  });
  const paypal = client;

  return handlePayPalWebhook(request, {
    webhookId: env.PAYPAL_WEBHOOK_ID,
    verifySignature: (input) => paypal.verifyWebhookSignature(input),
    record: (row) => recordPaymentEvent(createAdminClient(), row),
    // The event is only a hint: payments finds the attempt and asks PayPal what is true.
    apply: (eventId) =>
      applyWebhookEvent(createAdminClient(), createPaymentDeps(), eventId, { now: new Date().toISOString(), correlationId: newCorrelationId() }),
    // Stored only after PayPal itself confirmed the signature.
    evidenceLabel: "real-sandbox",
  });
}
