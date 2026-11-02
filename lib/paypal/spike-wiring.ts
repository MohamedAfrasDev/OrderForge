import "server-only";
import { getServerEnv } from "@/lib/env";
import { createPayPalClient, type PayPalClient } from "@/lib/paypal/client";
import { evidenceLabelFor, type EvidenceLabel, type SpikeDeps } from "@/lib/paypal/spike";
import { spikeStore } from "@/lib/paypal/spike-store";
import { newCorrelationId } from "@/lib/correlation";
import { createAdminClient } from "@/lib/supabase/admin";

let client: PayPalClient | undefined;

export function spikeTarget(): { baseUrl?: string; evidence: EvidenceLabel; isFake: boolean } {
  const baseUrl = getServerEnv().PAYPAL_SPIKE_BASE_URL;
  const evidence = evidenceLabelFor(baseUrl);
  return { baseUrl, evidence, isFake: evidence === "mocked" };
}

/** Everything the spike needs, wired to the real PayPal client (kept across requests for token caching) and database. */
export function createSpikeDeps(actor: string): SpikeDeps {
  const env = getServerEnv();
  const target = spikeTarget();
  client ??= createPayPalClient({
    env: "sandbox",
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    baseUrl: target.baseUrl,
  });
  const store = spikeStore(createAdminClient());
  return {
    client,
    recordEvent: store.recordEvent,
    insertAudit: store.insertAudit,
    evidenceLabel: target.evidence,
    // After approving, PayPal sends the buyer back to the dev page, which picks the order up from ?token=
    approvalReturnUrl: new URL("/merchant/dev/paypal", env.APP_BASE_URL).toString(),
    correlationId: newCorrelationId(),
    actor,
  };
}
