import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaymentEventRow } from "@/lib/paypal/webhook-handler";

const UNIQUE_VIOLATION = "23505";

/**
 * Stores a webhook event. payment_events.provider_event_id is UNIQUE, so a redelivery of the same
 * event cannot create a second row: the database, not application code, enforces deduplication.
 */
export async function recordPaymentEvent(db: SupabaseClient, row: PaymentEventRow): Promise<"recorded" | "duplicate"> {
  const { error } = await db.from("payment_events").insert(row);
  if (!error) return "recorded";
  if (error.code === UNIQUE_VIOLATION) return "duplicate";
  throw new Error(`payment_events insert failed: ${error.code ?? "unknown"}`);
}
