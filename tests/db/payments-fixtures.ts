import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { must, randomHash, unique } from "./helpers";
import { T0, createAttempt, markApproved, pay, recordOrder, attemptRow } from "./payments-helpers";
import { addMinutes, reservationOf, reserve, stockOf } from "./reservation-helpers";

export const begin = (db: SupabaseClient, attemptId: string, operation: string, now = T0) => pay(db, "payment_begin", { p_attempt_id: attemptId, p_operation: operation, p_now: now });
export const settle = (db: SupabaseClient, attemptId: string, outcome: string, extra: Record<string, unknown> = {}, now = T0) =>
  pay(db, "payment_settle", { p_attempt_id: attemptId, p_outcome: outcome, p_now: now, ...extra });

export type Condition = { code: string; text: string };

export type Fixture = {
  merchantId: string;
  inquiryId: string;
  quoteId: string;
  purchaseId: string;
  productId: string;
  attemptId: string;
  reservationId: string;
  quoteHash: string;
  authorizationId: string | null;
  attempt: () => ReturnType<typeof attemptRow>;
  reservation: () => ReturnType<typeof reservationOf>;
  stock: () => ReturnType<typeof stockOf>;
};

/**
 * A merchant, a purchase whose quote carries `conditions`, stock (10 units, 4 held by a reservation) and a payment attempt
 * taken to `state`. The reservation holds 4 of 10 units, so on_hand is 10 and reserved 4 until something settles.
 */
export async function payFixture(
  db: SupabaseClient,
  state: "CREATED" | "PROVIDER_CREATED" | "APPROVED" | "AUTHORIZED" = "AUTHORIZED",
  conditions: Condition[] = [],
): Promise<Fixture> {
  const merchant = must(await db.from("merchants").insert({ slug: unique("pf"), name: "Payment fixture merchant" }).select("id").single(), "merchant");
  const inquiry = must(await db.from("inquiries").insert({ merchant_id: merchant.id }).select("id").single(), "inquiry");
  const quoteHash = randomHash();
  const quote = must(
    await db
      .from("quote_versions")
      .insert({ inquiry_id: inquiry.id, version: 1, status: "PUBLISHED", lines: [], total_minor: 108000, quote_hash: quoteHash, pending_conditions: conditions })
      .select("id")
      .single(),
    "quote",
  );
  const approval = must(await db.from("approvals").insert({ quote_version_id: quote.id, quote_hash: quoteHash, terms_text: "t" }).select("id").single(), "approval");
  const purchase = must(
    await db.from("purchases").insert({ merchant_id: merchant.id, inquiry_id: inquiry.id, quote_version_id: quote.id, approval_id: approval.id }).select("id").single(),
    "purchase",
  );
  const product = must(
    await db.from("products").insert({ merchant_id: merchant.id, sku: `PF-${randomUUID().slice(0, 8)}`, name: "Fixture product", category: "test", unit_price_minor: 100 }).select("id").single(),
    "product",
  );
  must(await db.from("stock").insert({ product_id: product.id, on_hand: 10, reserved: 0 }), "stock");

  const held = await reserve(db, purchase.id as string, [{ product_id: product.id as string, quantity: 4 }]);
  const attempt = await createAttempt(db, { merchantId: merchant.id, inquiryId: inquiry.id, quoteId: quote.id, quoteHash, approvalId: approval.id, purchaseId: purchase.id } as never);
  const attemptId = attempt.attempt_id!;
  if (state !== "CREATED") await recordOrder(db, attemptId, unique("ORDER"));
  if (state === "APPROVED" || state === "AUTHORIZED") await markApproved(db, attemptId);

  const fixture: Fixture = {
    merchantId: merchant.id as string,
    inquiryId: inquiry.id as string,
    quoteId: quote.id as string,
    purchaseId: purchase.id as string,
    productId: product.id as string,
    attemptId,
    reservationId: held.reservation_id!,
    quoteHash,
    authorizationId: null,
    attempt: () => attemptRow(db, attemptId),
    reservation: () => reservationOf(db, purchase.id as string),
    stock: () => stockOf(db, product.id as string),
  };

  if (state === "AUTHORIZED") {
    const authorizationId = unique("AUTH");
    const begun = await begin(db, attemptId, "authorize");
    if (!begun.ok) throw new Error(`begin authorize: ${begun.code}`);
    const settled = await settle(db, attemptId, "AUTHORIZED", { p_authorization_id: authorizationId, p_authorization_expires_at: addMinutes(T0, 60 * 24 * 29) });
    if (!settled.ok) throw new Error(`settle AUTHORIZED: ${settled.code}`);
    fixture.authorizationId = authorizationId;
  }
  return fixture;
}

/** The merchant's decision RPC, with the verified merchant id the service layer would pass. */
export const decide = (
  db: SupabaseClient,
  f: Pick<Fixture, "purchaseId" | "merchantId">,
  decision: string,
  over: { confirmed?: unknown; reason?: string | null; now?: string; merchantId?: string } = {},
) =>
  pay(db, "payment_decide", {
    p_purchase_id: f.purchaseId,
    p_merchant_id: over.merchantId ?? f.merchantId,
    p_decision: decision,
    p_confirmed_conditions: over.confirmed ?? [],
    p_reason: over.reason ?? null,
    p_now: over.now ?? T0,
  });

export async function decisionOf(db: SupabaseClient, purchaseId: string) {
  return (await db.from("merchant_decisions").select("decision, reason, confirmed_conditions, decided_at, authorization_id").eq("purchase_id", purchaseId).maybeSingle()).data as
    | { decision: string; reason: string | null; confirmed_conditions: string[]; decided_at: string | null; authorization_id: string | null }
    | null;
}

/** Takes an attempt that is in flight for `operation` to OUTCOME_UNKNOWN (reservation in review, stock held). */
export async function unknownFixture(db: SupabaseClient, operation: "authorize" | "capture" | "void"): Promise<Fixture> {
  const f = await payFixture(db, operation === "authorize" ? "APPROVED" : "AUTHORIZED");
  if (operation === "authorize") {
    expectOk(await begin(db, f.attemptId, "authorize"));
  } else {
    expectOk(await decide(db, f, operation === "capture" ? "accepted" : "declined", { reason: operation === "void" ? "Cannot make it." : null }));
  }
  expectOk(await settle(db, f.attemptId, "UNKNOWN", { p_note: "timeout after 15s" }));
  return f;
}

function expectOk(r: { ok: boolean; code?: string }): void {
  if (!r.ok) throw new Error(`fixture step refused: ${r.code}`);
}
