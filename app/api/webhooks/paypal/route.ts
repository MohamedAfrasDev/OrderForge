import { getServerEnv } from "@/lib/env";
import { createPayPalClient, type PayPalClient } from "@/lib/paypal/client";
import { handlePayPalWebhook } from "@/lib/paypal/webhook-handler";
import { recordPaymentEvent } from "@/lib/paypal/webhook-store";
import { createAdminClient } from "@/lib/supabase/admin";

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
    // Stored only after PayPal itself confirmed the signature.
    evidenceLabel: "real-sandbox",
  });
}
