// Real local Postgres. Evidence label for this file: local database, not mocked.
import { describe, expect, it } from "vitest";
import { createCustomerLink } from "@/lib/access/customer-link";
import { authorizeCustomerLink, type VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { listHoldsForMerchant, readHoldForCustomer } from "@/services/reservation/read";
import { createMerchantUser, must, serviceClient, signedInClient } from "./helpers";
import { T0, acceptedChain, addMinutes, call, purchaseFor, reserve, stockedChain, expectStockConsistentAtEnd } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);
const SECRET = "db-test-secret-with-enough-length";

const begin = (id: string, operation: string) => call(db, "begin_operation", { p_reservation_id: id, p_operation: operation, p_now: T0 });
const settle = (id: string, outcome: string) => call(db, "settle_operation", { p_reservation_id: id, p_outcome: outcome, p_now: T0 });

async function verified(inquiryId: string): Promise<VerifiedInquiryId> {
  const token = createCustomerLink({ inquiryId, version: 1, expiresAt: new Date("2030-01-01T00:00:00Z"), secret: SECRET });
  const access = await authorizeCustomerLink(db, token, { secret: SECRET, now: new Date(T0) });
  if (!access.ok) throw new Error("expected a valid link");
  return access.inquiry.id;
}

/** An accepted purchase with a hold of 4 units, ready to be moved through the states. */
async function hold(ownerUserId?: string) {
  const s = await acceptedChain(db, { A: 10 }, ownerUserId);
  const r = await reserve(db, s.chain.purchaseId, [{ product_id: s.products.A!, quantity: 4 }]);
  return { ...s, reservationId: r.reservation_id!, who: await verified(s.chain.inquiryId) };
}

describe("readHoldForCustomer", () => {
  it("shows nothing when there is no accepted quote, or an accepted quote with no hold yet", async () => {
    const none = await stockedChain(db, { A: 5 }); // its quote is only PUBLISHED
    expect(await readHoldForCustomer(db, await verified(none.chain.inquiryId), T0)).toBeNull();

    const unreserved = await acceptedChain(db, { A: 5 });
    expect(await readHoldForCustomer(db, await verified(unreserved.chain.inquiryId), T0)).toBeNull();
  });

  it("a HELD reservation shows its expiry", async () => {
    const h = await hold();
    expect(await readHoldForCustomer(db, h.who, addMinutes(T0, 10))).toEqual({ state: "HELD", expiresAt: addMinutes(T0, 30) });
  });

  it("a HELD reservation past its expiry reads as ended even before the sweep has run", async () => {
    const h = await hold();
    expect(await readHoldForCustomer(db, h.who, addMinutes(T0, 29))).toMatchObject({ state: "HELD" });
    expect(await readHoldForCustomer(db, h.who, addMinutes(T0, 30))).toEqual({ state: "RELEASED", expiresAt: null });
  });

  it.each([
    ["in flight", async (id: string) => void (await begin(id, "authorize"))],
    [
      "awaiting confirmation",
      async (id: string) => {
        await begin(id, "authorize");
        await settle(id, "AUTHORIZED");
      },
    ],
    [
      "committed",
      async (id: string) => {
        await begin(id, "authorize");
        await settle(id, "AUTHORIZED");
        await begin(id, "capture");
        await settle(id, "CAPTURED");
      },
    ],
    [
      "in review",
      async (id: string) => {
        await begin(id, "authorize");
        await settle(id, "UNKNOWN");
      },
    ],
  ])("a reservation %s reads as secured, with no expiry and no internal detail", async (_label, advance) => {
    const h = await hold();
    await advance(h.reservationId);
    expect(await readHoldForCustomer(db, h.who, addMinutes(T0, 600))).toEqual({ state: "SECURED", expiresAt: null });
  });

  it("a released reservation reads as ended", async () => {
    const h = await hold();
    await call(db, "release_hold", { p_reservation_id: h.reservationId, p_reason: "ABANDONED", p_now: T0 });
    expect(await readHoldForCustomer(db, h.who, T0)).toEqual({ state: "RELEASED", expiresAt: null });
  });

  it("returns only the verified inquiry's own hold", async () => {
    const mine = await hold();
    const theirs = await hold();
    expect(await readHoldForCustomer(db, mine.who, T0)).toMatchObject({ expiresAt: addMinutes(T0, 30) });
    // A different customer, with no hold of their own, sees nothing of these.
    const stranger = await stockedChain(db, { A: 1 });
    expect(await readHoldForCustomer(db, await verified(stranger.chain.inquiryId), T0)).toBeNull();
    expect(theirs.reservationId).not.toBe(mine.reservationId);
  });

  it("ignores the hold of a quote that is no longer the accepted one", async () => {
    const h = await hold();
    must(await db.from("quote_versions").update({ status: "SUPERSEDED" }).eq("id", h.chain.quoteId));
    expect(await readHoldForCustomer(db, h.who, T0)).toBeNull();
  });

  it("exposes exactly two fields and no ids, quantities, product names or review notes", async () => {
    const h = await hold();
    await begin(h.reservationId, "authorize");
    await settle(h.reservationId, "UNKNOWN");
    const view = (await readHoldForCustomer(db, h.who, T0))!;
    expect(Object.keys(view).sort()).toEqual(["expiresAt", "state"]);
    expect(JSON.stringify(view)).not.toMatch(/REVIEW|review|timeout|reservation|purchase|merchant/i);
  });
});

describe("listHoldsForMerchant", () => {
  it("lists the merchant's live holds with their products and quantities, and flags the ones needing attention", async () => {
    const owner = await createMerchantUser(db);
    const s = await acceptedChain(db, { A: 50, B: 50 }, owner.id);
    const held = await reserve(db, s.chain.purchaseId, [{ product_id: s.products.A!, quantity: 4 }, { product_id: s.products.B!, quantity: 6 }]);

    const second = await purchaseFor(db, s.merchantId);
    const q2 = must(await db.from("purchases").select("quote_version_id").eq("id", second).single());
    must(await db.from("quote_versions").update({ status: "ACCEPTED" }).eq("id", q2.quote_version_id));
    const flagged = await reserve(db, second, [{ product_id: s.products.A!, quantity: 2 }]);
    await begin(flagged.reservation_id!, "authorize");
    await call(db, "settle_operation", { p_reservation_id: flagged.reservation_id!, p_outcome: "UNKNOWN", p_now: T0, p_reason: "timeout after 30s" });

    const session = await signedInClient(owner.email, owner.password);
    const list = await listHoldsForMerchant(session, s.merchantId);
    expect(list.map((h) => h.reservationId).sort()).toEqual([held.reservation_id, flagged.reservation_id].sort());

    const a = list.find((h) => h.reservationId === held.reservation_id)!;
    expect(a).toMatchObject({ state: "HELD", needsAttention: false, reviewReason: null, purchaseId: s.chain.purchaseId, inquiryId: s.chain.inquiryId });
    expect(new Date(a.expiresAt!).toISOString()).toBe(addMinutes(T0, 30));
    expect(a.lines.map((l) => l.quantity).sort()).toEqual([4, 6]);
    expect(a.lines.every((l) => l.name.length > 0 && l.sku.length > 0)).toBe(true);

    const b = list.find((h) => h.reservationId === flagged.reservation_id)!;
    expect(b).toMatchObject({ state: "REVIEW_REQUIRED", needsAttention: true, reviewReason: "timeout after 30s" });
    expect(list[0]!.needsAttention).toBe(true); // attention first
  });

  it("leaves out holds that have ended or been committed", async () => {
    const owner = await createMerchantUser(db);
    const released = await hold(owner.id);
    await call(db, "release_hold", { p_reservation_id: released.reservationId, p_reason: "ABANDONED", p_now: T0 });
    const session = await signedInClient(owner.email, owner.password);
    expect((await listHoldsForMerchant(session, released.merchantId)).map((h) => h.reservationId)).not.toContain(released.reservationId);
  });

  it("shows a merchant only their own holds, even when another merchant's id is asked for", async () => {
    const ownerA = await createMerchantUser(db);
    const ownerB = await createMerchantUser(db);
    const a = await hold(ownerA.id);
    const b = await hold(ownerB.id);
    const sessionA = await signedInClient(ownerA.email, ownerA.password);

    expect((await listHoldsForMerchant(sessionA, a.merchantId)).map((h) => h.reservationId)).toEqual([a.reservationId]);
    expect(await listHoldsForMerchant(sessionA, b.merchantId)).toEqual([]);
  });

  it("an empty list for a merchant with no holds", async () => {
    const owner = await createMerchantUser(db);
    const s = await stockedChain(db, { A: 1 }, owner.id);
    const session = await signedInClient(owner.email, owner.password);
    expect(await listHoldsForMerchant(session, s.merchantId)).toEqual([]);
  });
});
