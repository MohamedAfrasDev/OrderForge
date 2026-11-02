"use server";

import { requireMerchant } from "@/lib/access/require-merchant";
import { recordReconcileHeartbeat } from "@/lib/cron/reconcile-handler";
import { newCorrelationId } from "@/lib/correlation";
import { createSpikeOrder, finishSpike, type SpikeStep } from "@/lib/paypal/spike";
import { spikeStore } from "@/lib/paypal/spike-store";
import { createSpikeDeps, spikeTarget } from "@/lib/paypal/spike-wiring";
import { createAdminClient } from "@/lib/supabase/admin";

export type SpikeState = {
  orderId?: string;
  approveUrl?: string;
  steps: SpikeStep[];
  message?: string;
} | null;

export type ReconcileState = { message: string } | null;

const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Server actions are public endpoints, so every one of them re-checks the merchant session itself.
 * (requireMerchant redirects to the login page when there is no valid merchant session.)
 */
export async function spikeAction(_previous: SpikeState, formData: FormData): Promise<SpikeState> {
  const { user } = await requireMerchant();
  const actor = `merchant:${user.id}`;
  const intent = String(formData.get("intent") ?? "");
  const orderId = String(formData.get("orderId") ?? "");
  const deps = createSpikeDeps(actor);

  if (intent === "create") {
    const created = await createSpikeOrder(deps);
    return { orderId: created.orderId, approveUrl: created.approveUrl, steps: created.steps };
  }

  if (!ORDER_ID.test(orderId)) return { steps: [], message: "Create an order first." };

  if (intent === "approve-fake") {
    const target = spikeTarget();
    // Only ever against the local fake: the real sandbox needs a real buyer.
    if (!target.isFake || !target.baseUrl) return { orderId, steps: [], message: "Simulated approval only works with the local fake PayPal." };
    await fetch(`${target.baseUrl}/__fake/approve/${orderId}`, { method: "POST" });
    return { orderId, steps: [], message: "Simulated the buyer's approval (mocked)." };
  }

  if (intent === "capture" || intent === "void") {
    const report = await finishSpike(deps, { orderId, mode: intent });
    return { orderId, steps: report.steps };
  }

  return { orderId, steps: [], message: "Unknown action." };
}

/** The manual twin of the scheduled run: writes the same heartbeat, attributed to the signed-in merchant. */
export async function reconcileNowAction(): Promise<ReconcileState> {
  const { user } = await requireMerchant();
  try {
    await recordReconcileHeartbeat(spikeStore(createAdminClient()).insertAudit, {
      actor: `merchant:${user.id}`,
      correlationId: newCorrelationId(),
    });
    return { message: "Reconcile heartbeat recorded." };
  } catch {
    return { message: "Could not record the heartbeat." };
  }
}
