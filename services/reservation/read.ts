import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE_STATES, type ReservationState } from "@/domain/reservation";
import type { VerifiedInquiryId } from "@/lib/access/inquiry-reads";

/**
 * What a customer may know about the hold on their accepted quote. Deliberately coarse: HELD (with the time it ends),
 * SECURED (payment is under way, waiting on the merchant, or paid: the stock is theirs and no timer applies) and
 * RELEASED (the hold has ended). No ids, quantities, product names or internal states such as review.
 */
export type CustomerHoldView = { state: "HELD" | "SECURED" | "RELEASED"; expiresAt: string | null };

type Embedded<T> = T | T[] | null;
const one = <T>(value: Embedded<T>): T | null => (Array.isArray(value) ? (value[0] ?? null) : value);

/**
 * The hold behind the verified inquiry's ACCEPTED quote, or null when there is none (no accepted quote, or no hold yet).
 * A plain hold whose expiry has passed reads as ended without waiting for the sweep, because that is what is true.
 */
export async function readHoldForCustomer(db: SupabaseClient, inquiryId: VerifiedInquiryId, now: string): Promise<CustomerHoldView | null> {
  const quote = await db.from("quote_versions").select("id").eq("inquiry_id", inquiryId).eq("status", "ACCEPTED").maybeSingle();
  if (quote.error) throw new Error(`read accepted quote: ${quote.error.message}`);
  if (!quote.data) return null;

  const purchase = await db
    .from("purchases")
    .select("id, reservations(state, expires_at)")
    .eq("quote_version_id", quote.data.id as string)
    .maybeSingle();
  if (purchase.error) throw new Error(`read purchase: ${purchase.error.message}`);
  if (!purchase.data) return null;

  const reservation = one((purchase.data as unknown as { reservations: Embedded<{ state: ReservationState; expires_at: string | null }> }).reservations);
  if (!reservation) return null;

  if (reservation.state === "RELEASED") return { state: "RELEASED", expiresAt: null };
  if (reservation.state === "HELD") {
    const expiresAt = reservation.expires_at ? new Date(reservation.expires_at).toISOString() : null;
    if (expiresAt !== null && Date.parse(now) >= Date.parse(expiresAt)) return { state: "RELEASED", expiresAt: null };
    return { state: "HELD", expiresAt };
  }
  return { state: "SECURED", expiresAt: null };
}

export type HoldRow = {
  reservationId: string;
  purchaseId: string;
  inquiryId: string;
  state: ReservationState;
  inFlightOperation: string | null;
  expiresAt: string | null;
  stateChangedAt: string;
  reviewReason: string | null;
  /** REVIEW_REQUIRED: a person has to look at it. */
  needsAttention: boolean;
  lines: Array<{ sku: string; name: string; quantity: number }>;
};

type HoldQueryRow = {
  id: string;
  state: ReservationState;
  expires_at: string | null;
  state_changed_at: string;
  in_flight_operation: string | null;
  review_reason: string | null;
  purchase_id: string;
  purchases: Embedded<{ merchant_id: string; inquiry_id: string }>;
  reservation_lines: Array<{ quantity: number; products: Embedded<{ sku: string; name: string }> }>;
};

/**
 * The merchant's live holds (held, in flight, awaiting their decision, or needing attention), those needing attention first,
 * then newest first. Read-only. Pass the merchant's own session client so row level security applies: another merchant's
 * holds stay invisible even if their id were passed.
 */
export async function listHoldsForMerchant(db: SupabaseClient, merchantId: string, limit = 100): Promise<HoldRow[]> {
  const found = await db
    .from("reservations")
    .select(
      "id, state, expires_at, state_changed_at, in_flight_operation, review_reason, purchase_id, purchases!inner(merchant_id, inquiry_id), reservation_lines(quantity, products(sku, name))",
    )
    .eq("purchases.merchant_id", merchantId)
    .in("state", [...LIVE_STATES])
    .order("state_changed_at", { ascending: false })
    .limit(limit);
  if (found.error) throw new Error(`list holds: ${found.error.message}`);

  const rows = ((found.data ?? []) as unknown as HoldQueryRow[]).map<HoldRow>((r) => ({
    reservationId: r.id,
    purchaseId: r.purchase_id,
    inquiryId: one(r.purchases)!.inquiry_id,
    state: r.state,
    inFlightOperation: r.in_flight_operation,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    stateChangedAt: new Date(r.state_changed_at).toISOString(),
    reviewReason: r.review_reason,
    needsAttention: r.state === "REVIEW_REQUIRED",
    lines: r.reservation_lines
      .map((l) => ({ product: one(l.products), quantity: l.quantity }))
      .filter((l): l is { product: { sku: string; name: string }; quantity: number } => l.product !== null)
      .map((l) => ({ sku: l.product.sku, name: l.product.name, quantity: l.quantity }))
      .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)),
  }));

  // The query is newest first; attention first is a stable partition of that order.
  return [...rows.filter((r) => r.needsAttention), ...rows.filter((r) => !r.needsAttention)];
}
