// Shared set-up for the fulfillment specs. Payments run against the LOCAL FAKE PayPal (mocked evidence).
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createJobForPurchase } from "../services/fulfillment/create";
import { decide } from "../services/payments/decide";
import type { MerchantActor } from "../services/quote/shared";
import { authorizedPurchase, paymentDeps, type Accepted, type Seller } from "./payments-support";

export const actorOf = (seller: Seller): MerchantActor => ({ kind: "merchant", userId: randomUUID(), merchantId: seller.merchantId });

const ctx = () => ({ now: new Date().toISOString(), correlationId: "e2e-fulfillment" });

/** An accepted quote paid in full: authorized, then accepted by the merchant, so the payment is a verified capture. No job yet. */
export async function paidPurchase(db: SupabaseClient, seller: Seller): Promise<Accepted> {
  const p = await authorizedPurchase(db, seller);
  const done = await decide(db, paymentDeps(), actorOf(seller), p.purchaseId, "accepted", { confirmedConditions: [] }, ctx());
  if (!done.ok) throw new Error(`decide: ${done.code}`);
  return p;
}

/** The job of a paid purchase, made by the same service the accept action calls. */
export async function makeJob(db: SupabaseClient, purchaseId: string): Promise<string> {
  const made = await createJobForPurchase(db, purchaseId, ctx());
  if (!made.ok) throw new Error(`createJob: ${made.code}`);
  return made.value.jobId;
}

export async function jobOf(db: SupabaseClient, purchaseId: string) {
  const found = await db.from("preparation_jobs").select("id, status").eq("purchase_id", purchaseId).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  return found.data as { id: string; status: string } | null;
}

export async function eventCount(db: SupabaseClient, jobId: string): Promise<number> {
  const found = await db.from("preparation_events").select("id").eq("job_id", jobId);
  if (found.error) throw new Error(found.error.message);
  return (found.data ?? []).length;
}
