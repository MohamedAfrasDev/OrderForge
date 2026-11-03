import "server-only";
import { getServerEnv } from "@/lib/env";
import { createPayPalClient, type PayPalClient } from "@/lib/paypal/client";
import { evidenceLabelFor } from "@/lib/paypal/spike";
import type { PaymentDeps } from "@/services/payments/shared";

let client: PayPalClient | undefined;

/**
 * The payments services' dependencies: the PayPal client (kept across requests for token caching), the evidence label
 * (mocked when pointed at a local fake, real-sandbox otherwise) and the optional payee check.
 */
export function createPaymentDeps(): PaymentDeps {
  const env = getServerEnv();
  const baseUrl = env.PAYPAL_SPIKE_BASE_URL;
  client ??= createPayPalClient({ env: "sandbox", clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, baseUrl });
  return {
    paypal: client,
    evidence: evidenceLabelFor(baseUrl),
    ...(env.PAYPAL_PAYEE_MERCHANT_ID ? { payeeMerchantId: env.PAYPAL_PAYEE_MERCHANT_ID } : {}),
  };
}
