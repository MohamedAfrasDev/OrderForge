"use server";

import { refresh } from "next/cache";
import { requireMerchant } from "@/lib/access/require-merchant";
import { newCorrelationId } from "@/lib/correlation";
import { createPaymentDeps } from "@/lib/payments/wiring";
import { createAdminClient } from "@/lib/supabase/admin";
import { createJobForPurchase } from "@/services/fulfillment/create";
import { decide } from "@/services/payments/decide";
import { decisionFailureMessage } from "@/services/payments/customer-messages";
import { notifySoon } from "@/lib/notifications/run";

export type DecisionState = { status: "idle" } | { status: "error"; message: string } | { status: "done"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONDITION_CODE = /^[A-Z_]{1,64}$/;

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

// Server actions are public endpoints: the merchant session is verified first, before any field is read. The service
// then refuses (as NOT_FOUND) any purchase that belongs to another merchant. No amount or authorization id comes from
// the browser: only the purchase id, the conditions the merchant ticked and the reason they wrote.

async function run(formData: FormData, decision: "accepted" | "declined"): Promise<DecisionState> {
  const { user, merchant } = await requireMerchant();
  const purchaseId = field(formData, "purchaseId");
  if (!UUID.test(purchaseId)) return { status: "error", message: decisionFailureMessage("NOT_FOUND") };

  const confirmed = formData.getAll("confirm").filter((v): v is string => typeof v === "string" && CONDITION_CODE.test(v));
  const db = createAdminClient();
  const context = { now: new Date().toISOString(), correlationId: newCorrelationId() };
  const result = await decide(
    db,
    createPaymentDeps(),
    { kind: "merchant", userId: user.id, merchantId: merchant.id },
    purchaseId,
    decision,
    decision === "accepted" ? { confirmedConditions: confirmed } : { reason: field(formData, "reason").trim() },
    context,
  );

  // The money is taken: the order becomes a job. A failure here never fails the accept, because the scheduled reconcile run
  // creates the job of every paid purchase that has none.
  if (result.ok && decision === "accepted") {
    try {
      await createJobForPurchase(db, purchaseId, { ...context, actor: `merchant:${user.id}` });
    } catch {
      // Left for the reconcile run.
    }
  }
  refresh();
  notifySoon();
  if (result.ok) {
    return { status: "done", message: decision === "accepted" ? "Accepted. The payment was taken." : "Declined. The customer's authorization was cancelled and the stock released." };
  }
  return { status: "error", message: decisionFailureMessage(result.code, result.cause) };
}

export async function acceptOrderAction(_previous: DecisionState, formData: FormData): Promise<DecisionState> {
  return run(formData, "accepted");
}

export async function declineOrderAction(_previous: DecisionState, formData: FormData): Promise<DecisionState> {
  return run(formData, "declined");
}
