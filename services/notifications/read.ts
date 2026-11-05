import type { SupabaseClient } from "@supabase/supabase-js";

/** Whether the saved-link email was sent: "sent", on its way ("pending"), or null when there is nothing to say (no address, skipped, failed). */
export type LinkEmailStatus = "sent" | "pending" | null;

/**
 * What "Keep this page" may tell the customer about the email of their link. It says something only when it is true: a row that was
 * skipped (no provider) or failed says nothing, so the page never promises an email that is not coming. Never returns the address.
 */
export async function linkEmailStatus(db: SupabaseClient, inquiryId: string): Promise<LinkEmailStatus> {
  const row = await db.from("notifications").select("status").eq("inquiry_id", inquiryId).eq("kind", "request_started").maybeSingle();
  if (row.error) throw new Error(`link email status: ${row.error.message}`);
  if (row.data?.status === "SENT") return "sent";
  if (row.data?.status === "PENDING") return "pending";
  return null;
}
