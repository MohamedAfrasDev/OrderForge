// Real local Postgres. Quotes are produced by the real quote services (draft, publish, accept), so every purchase here
// is a genuine accepted quote. Evidence label for this file: local database, not mocked.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCustomerLink } from "@/lib/access/customer-link";
import { authorizeCustomerLink } from "@/lib/access/inquiry-reads";
import { acceptQuote } from "@/services/quote/accept";
import { createQuoteDraft } from "@/services/quote/create-draft";
import { publishQuote } from "@/services/quote/publish";
import { releaseForInvalidatedPurchases, releaseHold, flagForReview } from "@/services/reservation/release";
import { beginOperation, resolveReview, settleOperation } from "@/services/reservation/operations";
import { reserveForPurchase } from "@/services/reservation/reserve";
import { sweepReservations } from "@/services/reservation/sweep";
import { boxTemplate, products as fixtureProducts, stock as fixtureStock } from "../../supabase/seed/fixtures";
import { anonClient, codeOf, must, serviceClient, SQLSTATE, unique } from "./helpers";
import { newDraft, publish as rpcPublish, accept as rpcAccept } from "./quote-helpers";
import { T0, addMinutes, call, discrepancies, reservationOf, stockOf, unknownId } from "./reservation-helpers";

const db = serviceClient();
const SECRET = "db-test-secret-with-enough-length";
const ctx = { now: T0, correlationId: "corr-reservation-t5" };
const system = { kind: "system" } as const;
const requirements = { noFood: true, logoRequired: true, maxPricePerBoxMinor: 3999 };

type Merchant = { merchantId: string; product: Record<string, string> };

const TWO_SLOT_TEMPLATE = {
  slots: [
    { id: "notebook", label: "Notebook", quantity: 1, allowedSkus: ["NOTEBOOK-A5"] },
    { id: "pen", label: "Pen", quantity: 1, allowedSkus: ["PEN-BLK"] },
    { id: "spare", label: "Spare pens", quantity: 2, allowedSkus: ["PEN-BLK"] },
    { id: "card", label: "Branded card", quantity: 1, allowedSkus: ["CARD-BRANDED"], customization: "logo" },
    { id: "packaging", label: "Packaging", quantity: 1, allowedSkus: ["PACK-BOX"] },
  ],
};

/** A merchant of its own with the demo catalog and stock, so tests never share inventory. */
async function freshMerchant(template: unknown = boxTemplate, extraRules: Array<{ key: string; value: unknown }> = []): Promise<Merchant> {
  const merchant = must(await db.from("merchants").insert({ slug: unique("res"), name: "Reservation test merchant" }).select("id").single(), "merchant");
  const merchantId = merchant.id as string;
  const ids = new Map(fixtureProducts.map((p) => [p.id, randomUUID()]));
  must(await db.from("products").insert(fixtureProducts.map((p) => ({ ...p, id: ids.get(p.id)!, merchant_id: merchantId }))), "products");
  must(await db.from("stock").insert(fixtureStock.map((s) => ({ ...s, product_id: ids.get(s.product_id)! }))), "stock");
  must(
    await db.from("business_rules").insert([
      { merchant_id: merchantId, key: "box_template", value: template },
      { merchant_id: merchantId, key: "production_lead_days", value: { days: 7 } },
      ...extraRules.map((r) => ({ merchant_id: merchantId, ...r })),
    ]),
    "rules",
  );
  return { merchantId, product: Object.fromEntries(fixtureProducts.map((p) => [p.sku, ids.get(p.id)!])) };
}

const defaultSelections = (gift = "ORGANIZER-DESK") => ({ notebook: "NOTEBOOK-A5", pen: "PEN-BLK", gift, card: "CARD-BRANDED", packaging: "PACK-BOX" });
const twoSlotSelections = () => ({ notebook: "NOTEBOOK-A5", pen: "PEN-BLK", spare: "PEN-BLK", card: "CARD-BRANDED", packaging: "PACK-BOX" });

type Purchase = { inquiryId: string; quoteId: string; purchaseId: string; approvalId: string };

/** A real accepted quote: draft, publish, accept through the quote services. */
async function acceptedPurchase(m: Merchant, opts: { boxCount?: number; selections?: Record<string, string> } = {}): Promise<Purchase> {
  const inquiry = must(await db.from("inquiries").insert({ merchant_id: m.merchantId }).select("id").single(), "inquiry");
  const inquiryId = inquiry.id as string;
  const draft = await createQuoteDraft(
    db,
    { inquiryId, configuration: { boxCount: opts.boxCount ?? 30, selections: opts.selections ?? defaultSelections() }, requirements, requirementVersionId: null, conditions: [] },
    ctx,
  );
  if (!draft.ok) throw new Error(`draft: ${draft.code}`);
  const pub = await publishQuote(db, draft.value.quoteId, system, ctx);
  if (!pub.ok) throw new Error(`publish: ${pub.code}`);
  const token = createCustomerLink({ inquiryId, version: 1, expiresAt: new Date("2030-01-01T00:00:00Z"), secret: SECRET });
  const access = await authorizeCustomerLink(db, token, { secret: SECRET, now: new Date(T0) });
  if (!access.ok) throw new Error("link");
  const accepted = await acceptQuote(db, access.inquiry.id, draft.value.quoteId, pub.value.hash, ctx);
  if (!accepted.ok) throw new Error(`accept: ${accepted.code}`);
  return { inquiryId, quoteId: draft.value.quoteId, purchaseId: accepted.value.purchaseId, approvalId: accepted.value.approvalId };
}

const reservedOf = async (m: Merchant, sku: string) => (await stockOf(db, m.product[sku]!)).reserved;
const allProductIds = (m: Merchant) => Object.values(m.product);

async function auditFor(entityId: string) {
  return must(await db.from("audit_events").select("action, actor, correlation_id, data").eq("entity", "reservation").eq("entity_id", entityId).order("id")) as Array<{
    action: string;
    actor: string;
    correlation_id: string;
    data: Record<string, unknown>;
  }>;
}

async function reserved(m: Merchant, p?: Purchase) {
  const purchase = p ?? (await acceptedPurchase(m));
  const r = await reserveForPurchase(db, purchase.purchaseId, ctx);
  if (!r.ok) throw new Error(`reserve: ${r.code}`);
  return { ...purchase, reservationId: r.value.reservationId };
}

describe("reserveForPurchase", () => {
  it("holds what the accepted quote needs: 30 boxes means 30 of each of five products", async () => {
    const m = await freshMerchant();
    const p = await acceptedPurchase(m);
    const r = await reserveForPurchase(db, p.purchaseId, ctx);
    expect(r).toMatchObject({ ok: true, value: { reheld: false, already: false } });
    if (!r.ok) return;

    expect(new Date(r.value.expiresAt).toISOString()).toBe(addMinutes(T0, 30));
    expect(await reservationOf(db, p.purchaseId)).toMatchObject({ id: r.value.reservationId, state: "HELD" });
    for (const sku of ["NOTEBOOK-A5", "PEN-BLK", "ORGANIZER-DESK", "CARD-BRANDED", "PACK-BOX"]) expect(await reservedOf(m, sku), sku).toBe(30);
    expect(await reservedOf(m, "BOTTLE-STEEL")).toBe(0);
    expect(must(await db.from("reservation_lines").select("quantity").eq("reservation_id", r.value.reservationId))).toHaveLength(5);
    expect(await discrepancies(db, allProductIds(m))).toEqual([]);

    const events = await auditFor(r.value.reservationId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "reservation.reserved", actor: "system", correlation_id: "corr-reservation-t5" });
    expect(events[0]!.data).toMatchObject({ reservation_id: r.value.reservationId, purchase_id: p.purchaseId, to: "HELD" });
  });

  it("counts a product in two slots twice: pens in a 1-per-box slot and a 2-per-box slot, 10 boxes, need 30", async () => {
    const m = await freshMerchant(TWO_SLOT_TEMPLATE);
    const p = await acceptedPurchase(m, { boxCount: 10, selections: twoSlotSelections() });
    expect((await reserveForPurchase(db, p.purchaseId, ctx)).ok).toBe(true);
    expect(await reservedOf(m, "PEN-BLK")).toBe(30);
    expect(await reservedOf(m, "NOTEBOOK-A5")).toBe(10);
    expect(must(await db.from("reservation_lines").select("product_id, quantity").eq("product_id", m.product["PEN-BLK"]!))).toEqual([{ product_id: m.product["PEN-BLK"], quantity: 30 }]);
  });

  it("uses the merchant's reservation_hold_minutes rule, and fails loudly on a malformed one", async () => {
    const m = await freshMerchant(boxTemplate, [{ key: "reservation_hold_minutes", value: { minutes: 5 } }]);
    const r = await reserveForPurchase(db, (await acceptedPurchase(m)).purchaseId, ctx);
    expect(r.ok && new Date(r.value.expiresAt).toISOString()).toBe(addMinutes(T0, 5));

    const bad = await freshMerchant(boxTemplate, [{ key: "reservation_hold_minutes", value: { minutes: "soon" } }]);
    await expect(reserveForPurchase(db, (await acceptedPurchase(bad)).purchaseId, ctx)).rejects.toThrow(/reservation_hold_minutes/);
  });

  it("is idempotent: a second call returns the same reservation and holds once, with one audit event", async () => {
    const m = await freshMerchant();
    const p = await acceptedPurchase(m);
    const first = await reserveForPurchase(db, p.purchaseId, ctx);
    const again = await reserveForPurchase(db, p.purchaseId, ctx);
    expect(first.ok && again.ok && again.value).toMatchObject({ already: true, reservationId: first.ok ? first.value.reservationId : "" });
    expect(await reservedOf(m, "ORGANIZER-DESK")).toBe(30);
    expect(await auditFor(first.ok ? first.value.reservationId : "")).toHaveLength(1);
  });

  it("refuses with INSUFFICIENT_STOCK and the shortages when the stock is not there, holding nothing", async () => {
    const m = await freshMerchant();
    const p = await acceptedPurchase(m);
    must(await db.from("stock").update({ on_hand: 20 }).eq("product_id", m.product["ORGANIZER-DESK"]!));
    const r = await reserveForPurchase(db, p.purchaseId, ctx);
    expect(r).toMatchObject({ ok: false, code: "INSUFFICIENT_STOCK", shortages: [{ productId: m.product["ORGANIZER-DESK"], needed: 30, available: 20 }] });
    expect(await reservedOf(m, "NOTEBOOK-A5")).toBe(0);
    expect(await reservationOf(db, p.purchaseId)).toBeNull();
  });

  it("refuses a superseded quote: nothing is reserved, and the reason is named", async () => {
    const m = await freshMerchant();
    const p = await acceptedPurchase(m);
    const v2 = await createQuoteDraft(db, { inquiryId: p.inquiryId, configuration: { boxCount: 31, selections: defaultSelections() }, requirements, requirementVersionId: null, conditions: [] }, ctx);
    if (!v2.ok) throw new Error("draft");
    expect((await publishQuote(db, v2.value.quoteId, system, ctx)).ok).toBe(true);

    expect(await reserveForPurchase(db, p.purchaseId, ctx)).toMatchObject({ ok: false, code: "QUOTE_NOT_ACCEPTED", cause: "SUPERSEDED" });
    expect(await reservationOf(db, p.purchaseId)).toBeNull();
    expect(await reservedOf(m, "NOTEBOOK-A5")).toBe(0);
  });

  it("refuses a quote whose stored hash is not the hash of its content", async () => {
    const m = await freshMerchant();
    const inquiry = must(await db.from("inquiries").insert({ merchant_id: m.merchantId }).select("id").single());
    const draft = await newDraft(db, inquiry.id as string);
    const fake = await rpcPublish(db, draft.quoteId);
    const accepted = await rpcAccept(db, draft.quoteId, fake.hash);
    expect(accepted.ok).toBe(true);
    expect(await reserveForPurchase(db, accepted.purchase_id!, ctx)).toMatchObject({ ok: false, code: "QUOTE_NOT_ACCEPTED", cause: "QUOTE_TAMPERED" });
  });

  it("re-holds after an expiry, as long as the quote is still accepted and the stock is there", async () => {
    const m = await freshMerchant();
    const p = await acceptedPurchase(m);
    const first = await reserveForPurchase(db, p.purchaseId, ctx);
    await sweepReservations(db, { now: addMinutes(T0, 31), correlationId: "corr-expire" });
    expect(await reservedOf(m, "ORGANIZER-DESK")).toBe(0);

    const later = { ...ctx, now: addMinutes(T0, 40) };
    const again = await reserveForPurchase(db, p.purchaseId, later);
    expect(again).toMatchObject({ ok: true, value: { reheld: true, already: false, reservationId: first.ok ? first.value.reservationId : "" } });
    expect(await reservedOf(m, "ORGANIZER-DESK")).toBe(30);
    const events = await auditFor(first.ok ? first.value.reservationId : "");
    expect(events.map((e) => e.action)).toEqual(["reservation.reserved", "reservation.released", "reservation.reheld"]);
    expect(await discrepancies(db, allProductIds(m))).toEqual([]);
  });

  it("reports an unknown purchase as NOT_FOUND, and a SKU the merchant no longer sells as INVALID_INPUT", async () => {
    expect(await reserveForPurchase(db, unknownId(), ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });

    const m = await freshMerchant();
    const p = await acceptedPurchase(m);
    must(await db.from("products").delete().eq("id", m.product["CARD-BRANDED"]!));
    const r = await reserveForPurchase(db, p.purchaseId, ctx);
    expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(!r.ok && r.cause).toMatch(/CARD-BRANDED/);
    expect(await reservedOf(m, "NOTEBOOK-A5")).toBe(0);
  });

  it("two customers racing for the last units: one is held, the other is told it is short", async () => {
    const m = await freshMerchant();
    must(await db.from("stock").update({ on_hand: 40 }).eq("product_id", m.product["ORGANIZER-DESK"]!));
    const [a, b] = await Promise.all([acceptedPurchase(m), acceptedPurchase(m)]);
    const results = await Promise.all([reserveForPurchase(db, a.purchaseId, ctx), reserveForPurchase(db, b.purchaseId, ctx)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "INSUFFICIENT_STOCK", shortages: [{ needed: 30, available: 10 }] });
    expect(await reservedOf(m, "ORGANIZER-DESK")).toBe(30);
    expect(await discrepancies(db, allProductIds(m))).toEqual([]);
  });
});

describe("operation services", () => {
  const payments = { ...ctx, actor: "system:payments" };

  it("the lifecycle through the services: begin, settle, begin, settle, with audit by the named actor", async () => {
    const m = await freshMerchant();
    const r = await reserved(m);
    expect(await beginOperation(db, r.reservationId, "authorize", payments)).toMatchObject({ ok: true, value: { operation: "authorize" } });
    expect(await settleOperation(db, r.reservationId, "AUTHORIZED", payments)).toMatchObject({ ok: true, value: { state: "AWAITING_CONFIRMATION", already: false } });
    expect(await beginOperation(db, r.reservationId, "capture", payments)).toMatchObject({ ok: true });
    expect(await settleOperation(db, r.reservationId, "CAPTURED", payments)).toMatchObject({ ok: true, value: { state: "COMMITTED" } });

    expect(await stockOf(db, m.product["ORGANIZER-DESK"]!)).toEqual({ on_hand: 70, reserved: 0 });
    const events = await auditFor(r.reservationId);
    expect(events.map((e) => e.action)).toEqual(["reservation.reserved", "reservation.operation_begun", "reservation.settled", "reservation.operation_begun", "reservation.settled"]);
    expect(events.slice(1).every((e) => e.actor === "system:payments")).toBe(true);
    expect(events[1]!.data).toMatchObject({ to: "PAYMENT_IN_FLIGHT", operation: "authorize" });
    expect(events[4]!.data).toMatchObject({ to: "COMMITTED", status: "CAPTURED" });
    expect(await discrepancies(db, allProductIds(m))).toEqual([]);
  });

  it("a repeated settlement is a no-op and is not audited twice", async () => {
    const m = await freshMerchant();
    const r = await reserved(m);
    await beginOperation(db, r.reservationId, "authorize", payments);
    await settleOperation(db, r.reservationId, "AUTHORIZED", payments);
    expect(await settleOperation(db, r.reservationId, "AUTHORIZED", payments)).toMatchObject({ ok: true, value: { already: true } });
    expect((await auditFor(r.reservationId)).filter((e) => e.action === "reservation.settled")).toHaveLength(1);
  });

  it("a decline voids and releases with the reason DECLINED", async () => {
    const m = await freshMerchant();
    const r = await reserved(m);
    await beginOperation(db, r.reservationId, "authorize", payments);
    await settleOperation(db, r.reservationId, "AUTHORIZED", payments);
    await beginOperation(db, r.reservationId, "void", payments);
    expect(await settleOperation(db, r.reservationId, "VOIDED", payments, { releaseReason: "DECLINED" })).toMatchObject({ ok: true, value: { state: "RELEASED" } });
    expect(await reservationOf(db, r.purchaseId)).toMatchObject({ state: "RELEASED", release_reason: "DECLINED" });
    expect(await reservedOf(m, "ORGANIZER-DESK")).toBe(0);
  });

  it("passes the database's coded refusals through", async () => {
    const m = await freshMerchant();
    const r = await reserved(m);
    expect(await settleOperation(db, r.reservationId, "AUTHORIZED", payments)).toMatchObject({ ok: false, code: "NO_OPERATION_IN_FLIGHT" });
    expect(await beginOperation(db, r.reservationId, "capture", payments)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    await beginOperation(db, r.reservationId, "authorize", payments);
    expect(await beginOperation(db, r.reservationId, "authorize", payments)).toMatchObject({ ok: false, code: "OPERATION_IN_FLIGHT" });
    expect(await settleOperation(db, r.reservationId, "CAPTURED", payments)).toMatchObject({ ok: false, code: "OUTCOME_MISMATCH" });
    expect(await beginOperation(db, unknownId(), "authorize", payments)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("an authorize on an expired hold reports HOLD_EXPIRED and audits the release", async () => {
    const m = await freshMerchant();
    const r = await reserved(m);
    expect(await beginOperation(db, r.reservationId, "authorize", { ...payments, now: addMinutes(T0, 31) })).toMatchObject({ ok: false, code: "HOLD_EXPIRED" });
    expect(await reservedOf(m, "ORGANIZER-DESK")).toBe(0);
    const events = await auditFor(r.reservationId);
    expect(events.at(-1)).toMatchObject({ action: "reservation.released", actor: "system:payments" });
    expect(events.at(-1)!.data).toMatchObject({ from: "HELD", to: "RELEASED", reason: "EXPIRED" });
  });

  it("a failed authorization restarts the hold with the merchant's window", async () => {
    const m = await freshMerchant(boxTemplate, [{ key: "reservation_hold_minutes", value: { minutes: 15 } }]);
    const r = await reserved(m);
    await beginOperation(db, r.reservationId, "authorize", payments);
    const later = addMinutes(T0, 20);
    expect(await settleOperation(db, r.reservationId, "AUTHORIZE_FAILED", { ...payments, now: later })).toMatchObject({ ok: true, value: { state: "HELD" } });
    expect(new Date((await reservationOf(db, r.purchaseId))!.expires_at!).toISOString()).toBe(addMinutes(later, 15));
  });

  it("resolveReview records the evidence and the person who decided", async () => {
    const m = await freshMerchant();
    const r = await reserved(m);
    await beginOperation(db, r.reservationId, "authorize", payments);
    await settleOperation(db, r.reservationId, "UNKNOWN", payments, { note: "timeout after 30s" });
    expect(await reservationOf(db, r.purchaseId)).toMatchObject({ state: "REVIEW_REQUIRED", review_reason: "timeout after 30s" });

    const actor = { ...ctx, actor: "merchant:owner-1" };
    expect(await resolveReview(db, r.reservationId, "RELEASED", "PayPal shows no authorization exists", actor, { releaseReason: "ABANDONED" })).toMatchObject({ ok: true, value: { state: "RELEASED" } });
    expect(await reservedOf(m, "ORGANIZER-DESK")).toBe(0);
    const resolved = (await auditFor(r.reservationId)).find((e) => e.action === "reservation.review_resolved")!;
    expect(resolved).toMatchObject({ actor: "merchant:owner-1" });
    expect(resolved.data).toMatchObject({ to: "RELEASED", reason: "PayPal shows no authorization exists" });
  });

  it("resolving back to HELD restarts the hold with the merchant's window", async () => {
    const m = await freshMerchant(boxTemplate, [{ key: "reservation_hold_minutes", value: { minutes: 12 } }]);
    const r = await reserved(m);
    await beginOperation(db, r.reservationId, "authorize", payments);
    await settleOperation(db, r.reservationId, "UNKNOWN", payments);
    const now = addMinutes(T0, 60);
    expect((await resolveReview(db, r.reservationId, "HELD", "PayPal shows nothing happened", { ...ctx, now })).ok).toBe(true);
    expect(new Date((await reservationOf(db, r.purchaseId))!.expires_at!).toISOString()).toBe(addMinutes(now, 12));
  });
});

describe("releaseHold and flagForReview", () => {
  it("releases a plain hold once, audits it once, and refuses a reason it may not give", async () => {
    const m = await freshMerchant();
    const r = await reserved(m);
    expect(await releaseHold(db, r.reservationId, "ABANDONED", ctx)).toMatchObject({ ok: true, value: { already: false } });
    expect(await releaseHold(db, r.reservationId, "ABANDONED", ctx)).toMatchObject({ ok: true, value: { already: true } });
    expect((await auditFor(r.reservationId)).filter((e) => e.action === "reservation.released")).toHaveLength(1);
    expect(await reservedOf(m, "ORGANIZER-DESK")).toBe(0);

    const other = await reserved(m);
    expect(await releaseHold(db, other.reservationId, "DECLINED" as never, ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("refuses to release a reservation that is in flight", async () => {
    const m = await freshMerchant();
    const r = await reserved(m);
    await beginOperation(db, r.reservationId, "authorize", ctx);
    expect(await releaseHold(db, r.reservationId, "ABANDONED", ctx)).toMatchObject({ ok: false, code: "OPERATION_IN_FLIGHT" });
  });

  it("flags in-flight and awaiting reservations for review, keeping stock held, and audits it", async () => {
    const m = await freshMerchant();
    const inFlight = await reserved(m);
    await beginOperation(db, inFlight.reservationId, "authorize", ctx);
    expect(await flagForReview(db, inFlight.reservationId, "quote is no longer accepted", ctx)).toMatchObject({ ok: true, value: { already: false } });
    expect(await reservationOf(db, inFlight.purchaseId)).toMatchObject({ state: "REVIEW_REQUIRED", in_flight_operation: null });
    expect(await flagForReview(db, inFlight.reservationId, "again", ctx)).toMatchObject({ ok: true, value: { already: true } });
    expect(await reservedOf(m, "ORGANIZER-DESK")).toBe(30);
    expect((await auditFor(inFlight.reservationId)).filter((e) => e.action === "reservation.flagged_for_review")).toHaveLength(1);
  });

  it("will not flag a plain hold or an unknown reservation, and refuses a blank reason", async () => {
    const m = await freshMerchant();
    const held = await reserved(m);
    expect(await flagForReview(db, held.reservationId, "x", ctx)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(await flagForReview(db, held.reservationId, "  ", ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await flagForReview(db, unknownId(), "x", ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("flag_for_review cannot be called by the anon role", async () => {
    expect(codeOf(await anonClient().rpc("flag_for_review", { p_reservation_id: unknownId(), p_reason: "x", p_now: T0 }))).toBe(SQLSTATE.denied);
    expect(typeof (await call(db, "flag_for_review", { p_reservation_id: unknownId(), p_reason: "x", p_now: T0 })).ok).toBe("boolean");
  });
});

describe("releaseForInvalidatedPurchases", () => {
  async function supersede(p: Purchase): Promise<string[]> {
    const v2 = await createQuoteDraft(db, { inquiryId: p.inquiryId, configuration: { boxCount: 5, selections: defaultSelections() }, requirements, requirementVersionId: null, conditions: [] }, ctx);
    if (!v2.ok) throw new Error(`draft: ${v2.code}`);
    const pub = await publishQuote(db, v2.value.quoteId, system, ctx);
    if (!pub.ok) throw new Error(`publish: ${pub.code}`);
    return pub.value.invalidatedPurchaseIds;
  }

  it("releases a plain hold, sends in-flight money to review, and skips what needs nothing", async () => {
    const m = await freshMerchant();
    // Accepted first: once three holds exist the advisory stock check would (rightly) refuse another 30-box quote.
    const unreserved = await acceptedPurchase(m);
    const plain = await reserved(m);
    const awaitingConfirmation = await reserved(m);
    const committed = await reserved(m);

    await beginOperation(db, awaitingConfirmation.reservationId, "authorize", ctx);
    await settleOperation(db, awaitingConfirmation.reservationId, "AUTHORIZED", ctx);
    await beginOperation(db, committed.reservationId, "authorize", ctx);
    await settleOperation(db, committed.reservationId, "AUTHORIZED", ctx);
    await beginOperation(db, committed.reservationId, "capture", ctx);
    await settleOperation(db, committed.reservationId, "CAPTURED", ctx);

    const invalidated: string[] = [];
    for (const p of [plain, awaitingConfirmation, committed, unreserved]) invalidated.push(...(await supersede(p)));
    expect(invalidated).toHaveLength(4);

    const r = await releaseForInvalidatedPurchases(db, [...invalidated, unknownId()], ctx);
    expect(r).toMatchObject({ ok: true, value: { released: 1, flagged: 1, skipped: 3 } });

    expect(await reservationOf(db, plain.purchaseId)).toMatchObject({ state: "RELEASED", release_reason: "SUPERSEDED" });
    expect(await reservationOf(db, awaitingConfirmation.purchaseId)).toMatchObject({ state: "REVIEW_REQUIRED" });
    expect((await reservationOf(db, awaitingConfirmation.purchaseId))!.review_reason).toMatch(/no longer accepted/);
    expect((await reservationOf(db, committed.purchaseId))!.state).toBe("COMMITTED");
    expect(await reservationOf(db, unreserved.purchaseId)).toBeNull();

    // Held: the awaiting one (30). Released: the plain one. Committed: 30 left the shelf.
    expect(await stockOf(db, m.product["ORGANIZER-DESK"]!)).toEqual({ on_hand: 70, reserved: 30 });
    expect(await discrepancies(db, allProductIds(m))).toEqual([]);
  });

  it("is safe to repeat, and the sweep reaches the same result", async () => {
    const m = await freshMerchant();
    const plain = await reserved(m);
    const ids = await supersede(plain);
    await releaseForInvalidatedPurchases(db, ids, ctx);
    expect(await releaseForInvalidatedPurchases(db, ids, ctx)).toMatchObject({ ok: true, value: { released: 0, flagged: 0, skipped: 1 } });
    const swept = await sweepReservations(db, { now: addMinutes(T0, 1), correlationId: "corr-orphans" });
    expect(swept.changes.map((c) => c.reservationId)).not.toContain(plain.reservationId);
    expect(await reservedOf(m, "ORGANIZER-DESK")).toBe(0);
  });

  it("does nothing for an empty list", async () => {
    expect(await releaseForInvalidatedPurchases(db, [], ctx)).toMatchObject({ ok: true, value: { released: 0, flagged: 0, skipped: 0 } });
  });

  it("a hold that moved into flight after it was listed is flagged for review instead of released", async () => {
    const m = await freshMerchant();
    const r = await reserved(m);
    const ids = await supersede(r);
    await beginOperation(db, r.reservationId, "authorize", ctx);
    const out = await releaseForInvalidatedPurchases(db, ids, ctx);
    expect(out).toMatchObject({ ok: true, value: { released: 0, flagged: 1 } });
    expect(await reservedOf(m, "ORGANIZER-DESK")).toBe(30);
  });
});
