import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE_STATES, stockInvariant, type ReservationState } from "@/domain/reservation";
import { createChain, must, randomHash, unique, type Chain } from "./helpers";

export const T0 = "2026-11-03T10:00:00.000Z";

export const addMinutes = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

export type RpcOut = {
  ok: boolean;
  code?: string;
  already?: boolean;
  reheld?: boolean;
  reservation_id?: string;
  operation?: string;
  expires_at?: string;
  state?: string;
  shortages?: Array<{ product_id: string; needed: number; available: number }>;
};

export async function call(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<RpcOut> {
  return must(await db.rpc(fn, args), fn) as RpcOut;
}

export type Line = { product_id: string; quantity: number };

export const reserve = (db: SupabaseClient, purchaseId: string, lines: Line[], now = T0, holdMinutes = 30) =>
  call(db, "reserve_stock", { p_purchase_id: purchaseId, p_lines: lines, p_now: now, p_hold_minutes: holdMinutes });

export const releaseHold = (db: SupabaseClient, reservationId: string, reason: string, now = T0) =>
  call(db, "release_hold", { p_reservation_id: reservationId, p_reason: reason, p_now: now });

export type Stocked = { chain: Chain; merchantId: string; products: Record<string, string> };

/** A merchant with a purchase and the given products, each with `on_hand` stock and nothing reserved. */
export async function stockedChain(db: SupabaseClient, onHandBySku: Record<string, number>, ownerUserId?: string): Promise<Stocked> {
  const chain = await createChain(db, ownerUserId);
  const products: Record<string, string> = {};
  for (const [sku, onHand] of Object.entries(onHandBySku)) {
    const row = must(
      await db
        .from("products")
        .insert({ merchant_id: chain.merchantId, sku: `${sku}-${unique("r")}`.slice(0, 60), name: sku, category: "test", unit_price_minor: 100 })
        .select("id")
        .single(),
      `product ${sku}`,
    );
    products[sku] = row.id as string;
    must(await db.from("stock").insert({ product_id: row.id, on_hand: onHand, reserved: 0 }), `stock ${sku}`);
  }
  return { chain, merchantId: chain.merchantId, products };
}

/** Another customer's purchase for the same merchant. */
export async function purchaseFor(db: SupabaseClient, merchantId: string): Promise<string> {
  const inquiry = must(await db.from("inquiries").insert({ merchant_id: merchantId }).select("id").single(), "inquiry");
  const hash = randomHash();
  const quote = must(
    await db
      .from("quote_versions")
      .insert({ inquiry_id: inquiry.id, version: 1, status: "PUBLISHED", lines: [], total_minor: 1, quote_hash: hash })
      .select("id")
      .single(),
    "quote",
  );
  const approval = must(
    await db.from("approvals").insert({ quote_version_id: quote.id, quote_hash: hash, terms_text: "t" }).select("id").single(),
    "approval",
  );
  const purchase = must(
    await db
      .from("purchases")
      .insert({ merchant_id: merchantId, inquiry_id: inquiry.id, quote_version_id: quote.id, approval_id: approval.id })
      .select("id")
      .single(),
    "purchase",
  );
  return purchase.id as string;
}

export async function stockOf(db: SupabaseClient, productId: string): Promise<{ on_hand: number; reserved: number }> {
  return must(await db.from("stock").select("on_hand, reserved").eq("product_id", productId).single(), "stock") as { on_hand: number; reserved: number };
}

export async function reservationOf(db: SupabaseClient, purchaseId: string) {
  return (await db.from("reservations").select("id, state, expires_at, in_flight_operation, release_reason, review_reason, state_changed_at").eq("purchase_id", purchaseId).maybeSingle()).data as
    | { id: string; state: ReservationState; expires_at: string | null; in_flight_operation: string | null; release_reason: string | null; review_reason: string | null; state_changed_at: string }
    | null;
}

/** Asserts the stock invariant for these products against what the database actually holds. Returns discrepancies. */
export async function discrepancies(db: SupabaseClient, productIds: string[]) {
  const stock = must(await db.from("stock").select("product_id, on_hand, reserved").in("product_id", productIds), "stock");
  const lines = must(
    await db.from("reservation_lines").select("product_id, quantity, reservations!inner(state)").in("product_id", productIds),
    "lines",
  ) as unknown as Array<{ product_id: string; quantity: number; reservations: { state: ReservationState } | { state: ReservationState }[] }>;
  const live = lines
    .filter((l) => LIVE_STATES.includes((Array.isArray(l.reservations) ? l.reservations[0]! : l.reservations).state))
    .map((l) => ({ productId: l.product_id, quantity: l.quantity }));
  return stockInvariant(
    stock.map((s) => ({ productId: s.product_id as string, onHand: s.on_hand as number, reserved: s.reserved as number })),
    live,
  );
}

export const unknownId = () => randomUUID();

/** Marks the quote behind a chain as ACCEPTED, as it is for any real purchase (the sweep treats other statuses as orphaned). */
export async function acceptQuoteOf(db: SupabaseClient, quoteId: string): Promise<void> {
  must(await db.from("quote_versions").update({ status: "ACCEPTED" }).eq("id", quoteId), "accept quote");
}

/** A stocked chain whose quote is ACCEPTED. */
export async function acceptedChain(db: SupabaseClient, onHandBySku: Record<string, number>, ownerUserId?: string): Promise<Stocked> {
  const s = await stockedChain(db, onHandBySku, ownerUserId);
  await acceptQuoteOf(db, s.chain.quoteId);
  return s;
}

/** Another customer's purchase for the same merchant, with an ACCEPTED quote. */
export async function acceptedPurchaseFor(db: SupabaseClient, merchantId: string): Promise<{ purchaseId: string; quoteId: string }> {
  const purchaseId = await purchaseFor(db, merchantId);
  const row = must(await db.from("purchases").select("quote_version_id").eq("id", purchaseId).single(), "purchase");
  await acceptQuoteOf(db, row.quote_version_id as string);
  return { purchaseId, quoteId: row.quote_version_id as string };
}
