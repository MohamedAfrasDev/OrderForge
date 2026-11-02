import type { SupabaseClient } from "@supabase/supabase-js";
import { requiredQuantities, type ReservationResult } from "@/domain/reservation";
import { audit } from "@/lib/audit";
import { verifyApprovalBinding } from "@/services/quote/verify-binding";
import { actorOf, auditInsertFor, callRpc, failure, holdMinutesFor, type ServiceContext } from "./shared";

export type Reserved = { reservationId: string; expiresAt: string; reheld: boolean; already: boolean };

/**
 * Holds the stock an accepted quote needs, all or nothing. Checkout calls this right after the customer accepts.
 * The quote must still be ACCEPTED with an intact hash (`verifyApprovalBinding`), so a replaced or tampered quote
 * reserves nothing. Quantities come from the accepted snapshot (line quantity x box count, summed per product) and
 * never from the caller. Idempotent per purchase; a hold that expired can be taken up again while the quote stands.
 */
export async function reserveForPurchase(db: SupabaseClient, purchaseId: string, ctx: ServiceContext): Promise<ReservationResult<Reserved>> {
  const purchase = await db.from("purchases").select("id, merchant_id, approval_id").eq("id", purchaseId).maybeSingle();
  if (purchase.error) throw new Error(`load purchase: ${purchase.error.message}`);
  if (!purchase.data) return { ok: false, code: "NOT_FOUND" };
  const merchantId = purchase.data.merchant_id as string;

  const binding = await verifyApprovalBinding(db, purchase.data.approval_id as string);
  if (!binding.ok) return { ok: false, code: "QUOTE_NOT_ACCEPTED", cause: binding.code };
  const { snapshot } = binding.value;
  if (snapshot.merchantId !== merchantId) return { ok: false, code: "INVALID_INPUT", cause: "quote and purchase belong to different merchants" };

  const skus = [...new Set(snapshot.lines.map((l) => l.sku))];
  const found = await db.from("products").select("id, sku").eq("merchant_id", merchantId).in("sku", skus);
  if (found.error) throw new Error(`load products: ${found.error.message}`);
  const productBySku = new Map((found.data ?? []).map((p) => [p.sku as string, p.id as string]));
  const missing = skus.filter((sku) => !productBySku.has(sku));
  if (missing.length > 0) return { ok: false, code: "INVALID_INPUT", cause: `unknown SKU: ${missing.join(", ")}` };

  const needs = requiredQuantities(snapshot, productBySku);
  const holdMinutes = await holdMinutesFor(db, merchantId);

  const out = await callRpc(db, "reserve_stock", {
    p_purchase_id: purchaseId,
    p_lines: needs.map((n) => ({ product_id: n.productId, quantity: n.quantity })),
    p_now: ctx.now,
    p_hold_minutes: holdMinutes,
  });
  if (!out.ok) return failure(out);

  const reserved: Reserved = {
    reservationId: out.reservation_id!,
    expiresAt: out.expires_at!,
    reheld: out.reheld === true,
    already: out.already === true,
  };

  if (!reserved.already) {
    await audit(auditInsertFor(db), {
      actor: actorOf(ctx),
      action: reserved.reheld ? "reservation.reheld" : "reservation.reserved",
      entity: "reservation",
      entityId: reserved.reservationId,
      correlationId: ctx.correlationId,
      data: { reservation_id: reserved.reservationId, purchase_id: purchaseId, ...(reserved.reheld ? { from: "RELEASED" } : {}), to: "HELD" },
    });
  }
  return { ok: true, value: reserved };
}
