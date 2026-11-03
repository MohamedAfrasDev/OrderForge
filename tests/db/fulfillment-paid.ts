// Real accepted quotes taken through the payments services against the LOCAL FAKE PayPal (mocked evidence), so fulfillment
// tests start from purchases that are really paid (or really not).
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPayPalClient } from "@/lib/paypal/client";
import { completeApproval, startCheckout } from "@/services/payments/checkout";
import { decide } from "@/services/payments/decide";
import type { PayPalPort } from "@/services/payments/shared";
import type { MerchantActor } from "@/services/quote/shared";
import type { FakePayPal } from "../support/fake-paypal";
import { acceptedPurchase, freshMerchant, type AcceptedPurchase, type Merchant } from "./accepted-purchase";
import { must } from "./helpers";
import { T0 } from "./payments-helpers";

export const SLOT = { code: "PRODUCTION_SLOT_CONFIRMATION", text: "Production slot to be confirmed." };
export const ARTWORK = { code: "ARTWORK_ACCEPTANCE", text: "Artwork to be accepted." };

export const paypalFor = (fake: FakePayPal): PayPalPort =>
  createPayPalClient({ env: "sandbox", clientId: "test-client", clientSecret: "test-secret-0000000000", baseUrl: fake.url, timeoutMs: 400 });

export type Paid = AcceptedPurchase & { m: Merchant; actor: MerchantActor };

/**
 * An accepted quote of 30 boxes taken as far as `upTo`: "accepted" (nothing paid), "authorized" (waiting for the merchant),
 * "declined" (voided) or "captured" (paid).
 */
export async function takeTo(
  db: SupabaseClient,
  fake: FakePayPal,
  upTo: "accepted" | "authorized" | "declined" | "captured",
  opts: { merchant?: Merchant; conditions?: unknown[]; confirmed?: string[] } = {},
): Promise<Paid> {
  const m = opts.merchant ?? (await freshMerchant(db));
  const p = await acceptedPurchase(db, m, { conditions: opts.conditions ?? [] });
  const actor: MerchantActor = { kind: "merchant", userId: randomUUID(), merchantId: m.merchantId };
  const out: Paid = { ...p, m, actor };
  if (upTo === "accepted") return out;

  const paypal = paypalFor(fake);
  const deps = { paypal, evidence: "mocked" as const };
  const ctx = { now: T0, correlationId: "corr-fulfillment-paid" };
  const started = await startCheckout(db, deps, p.who, p.purchaseId, { returnUrl: "http://localhost:3100/o/TOKEN/return" }, ctx);
  if (!started.ok) throw new Error(`startCheckout: ${started.code}`);
  const orderId = must(await db.from("payment_attempts").select("paypal_order_id").eq("purchase_id", p.purchaseId).single()).paypal_order_id as string;
  fake.approve(orderId);
  const authorized = await completeApproval(db, deps, p.who, orderId, ctx);
  if (!authorized.ok) throw new Error(`completeApproval: ${authorized.code}`);
  if (upTo === "authorized") return out;

  const decided =
    upTo === "captured"
      ? await decide(db, deps, actor, p.purchaseId, "accepted", { confirmedConditions: opts.confirmed ?? [] }, ctx)
      : await decide(db, deps, actor, p.purchaseId, "declined", { reason: "Cannot make it in time." }, ctx);
  if (!decided.ok) throw new Error(`decide: ${decided.code}`);
  return out;
}
