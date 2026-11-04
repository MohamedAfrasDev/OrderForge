import type { SupabaseClient } from "@supabase/supabase-js";
import { listDecisionsForMerchant } from "@/services/payments/read";
import { listJobsForMerchant } from "@/services/fulfillment/read";

export type MerchantOverview = {
  /** Requests the assistant handed over or held for the shop, which wait for the shop to answer. */
  requestsToAnswer: number;
  /** Payments the customer has approved on PayPal that wait for the shop's yes or no. */
  paymentsToDecide: number;
  /** Orders accepted and paid that are not collected yet. */
  ordersToPrepare: number;
};

/**
 * The three counts on the shop's Today page. Read under the shop's own session, so row level security decides what is counted: another
 * shop's work, or a visitor with no session, counts as nothing. A held draft's inquiry is itself `REVIEW_REQUIRED`, so it is counted once.
 */
export async function merchantOverview(db: SupabaseClient, merchantId: string, now: string = new Date().toISOString()): Promise<MerchantOverview> {
  const [inquiries, decisions, jobs] = await Promise.all([
    db.from("inquiries").select("id", { count: "exact", head: true }).eq("merchant_id", merchantId).eq("status", "REVIEW_REQUIRED"),
    listDecisionsForMerchant(db, merchantId, now, 1000),
    listJobsForMerchant(db, merchantId, 1000),
  ]);
  if (inquiries.error) throw new Error(`overview requests: ${inquiries.error.message}`);
  return {
    requestsToAnswer: inquiries.count ?? 0,
    paymentsToDecide: decisions.filter((d) => d.section === "waiting").length,
    ordersToPrepare: jobs.filter((j) => j.status !== "COLLECTED").length,
  };
}
