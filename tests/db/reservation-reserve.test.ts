// Real local Postgres. Evidence label for this file: local database, not mocked.
import { describe, expect, it } from "vitest";
import { anonClient, codeOf, must, serviceClient, SQLSTATE } from "./helpers";
import {
  T0,
  addMinutes,
  discrepancies,
  purchaseFor,
  releaseHold,
  reservationOf,
  reserve,
  stockOf,
  stockedChain,
  unknownId,
  expectStockConsistentAtEnd,
} from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);
const ids = (p: Record<string, string>) => Object.values(p);

describe("reserve_stock", () => {
  it("demo step A: holds 30 of each of five products and sets the expiry", async () => {
    const s = await stockedChain(db, { NB: 500, PEN: 500, ORG: 100, CARD: 500, PKG: 200 });
    const lines = Object.values(s.products).map((product_id) => ({ product_id, quantity: 30 }));
    const r = await reserve(db, s.chain.purchaseId, lines);
    expect(r).toMatchObject({ ok: true, already: false, reheld: false });

    const res = await reservationOf(db, s.chain.purchaseId);
    expect(res).toMatchObject({ id: r.reservation_id, state: "HELD", in_flight_operation: null, release_reason: null });
    expect(new Date(res!.expires_at!).toISOString()).toBe(addMinutes(T0, 30));
    expect(new Date(res!.state_changed_at).toISOString()).toBe(T0);
    for (const id of ids(s.products)) expect((await stockOf(db, id)).reserved).toBe(30);
    expect(must(await db.from("reservation_lines").select("quantity").eq("reservation_id", r.reservation_id!))).toHaveLength(5);
    expect(await discrepancies(db, ids(s.products))).toEqual([]);
  });

  it("uses the hold window it is given", async () => {
    const s = await stockedChain(db, { A: 10 });
    const r = await reserve(db, s.chain.purchaseId, [{ product_id: s.products.A!, quantity: 1 }], T0, 5);
    expect(new Date(r.expires_at!).toISOString()).toBe(addMinutes(T0, 5));
  });

  it("demo step B: two customers racing for the last 24 bottles at 13 each, exactly one wins and nothing partial is left", async () => {
    const s = await stockedChain(db, { BOTTLE: 24 });
    const other = await purchaseFor(db, s.merchantId);
    const line = [{ product_id: s.products.BOTTLE!, quantity: 13 }];
    const results = await Promise.all([reserve(db, s.chain.purchaseId, line), reserve(db, other, line)]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(loser).toMatchObject({ code: "INSUFFICIENT_STOCK", shortages: [{ product_id: s.products.BOTTLE, needed: 13, available: 11 }] });
    expect((await stockOf(db, s.products.BOTTLE!)).reserved).toBe(13);
    const rows = [await reservationOf(db, s.chain.purchaseId), await reservationOf(db, other)];
    expect(rows.filter(Boolean)).toHaveLength(1);
    expect(await discrepancies(db, ids(s.products))).toEqual([]);
  });

  it("is all or nothing: a short second product leaves the first untouched and creates no reservation", async () => {
    const s = await stockedChain(db, { A: 100, B: 5 });
    const r = await reserve(db, s.chain.purchaseId, [
      { product_id: s.products.A!, quantity: 10 },
      { product_id: s.products.B!, quantity: 6 },
    ]);
    expect(r).toMatchObject({ ok: false, code: "INSUFFICIENT_STOCK" });
    expect((await stockOf(db, s.products.A!)).reserved).toBe(0);
    expect((await stockOf(db, s.products.B!)).reserved).toBe(0);
    expect(await reservationOf(db, s.chain.purchaseId)).toBeNull();
  });

  it("lists every short product, with needed and available, ordered by product id", async () => {
    const s = await stockedChain(db, { A: 3, B: 4, C: 100 });
    const r = await reserve(db, s.chain.purchaseId, [
      { product_id: s.products.A!, quantity: 5 },
      { product_id: s.products.B!, quantity: 9 },
      { product_id: s.products.C!, quantity: 1 },
    ]);
    const expected = [
      { product_id: s.products.A!, needed: 5, available: 3 },
      { product_id: s.products.B!, needed: 9, available: 4 },
    ].sort((x, y) => (x.product_id < y.product_id ? -1 : 1));
    expect(r.shortages).toEqual(expected);
  });

  it("counts stock already reserved by others as unavailable", async () => {
    const s = await stockedChain(db, { A: 10 });
    const other = await purchaseFor(db, s.merchantId);
    await reserve(db, other, [{ product_id: s.products.A!, quantity: 7 }]);
    const r = await reserve(db, s.chain.purchaseId, [{ product_id: s.products.A!, quantity: 4 }]);
    expect(r).toMatchObject({ ok: false, code: "INSUFFICIENT_STOCK", shortages: [{ needed: 4, available: 3 }] });
  });

  it("reports a product with no stock row as zero available", async () => {
    const s = await stockedChain(db, { A: 10 });
    must(await db.from("stock").delete().eq("product_id", s.products.A!));
    const r = await reserve(db, s.chain.purchaseId, [{ product_id: s.products.A!, quantity: 1 }]);
    expect(r.shortages).toEqual([{ product_id: s.products.A, needed: 1, available: 0 }]);
  });

  it("is idempotent: reserving the same purchase twice returns the same reservation and holds once", async () => {
    const s = await stockedChain(db, { A: 10 });
    const line = [{ product_id: s.products.A!, quantity: 4 }];
    const first = await reserve(db, s.chain.purchaseId, line);
    const second = await reserve(db, s.chain.purchaseId, line);
    expect(second).toMatchObject({ ok: true, already: true, reservation_id: first.reservation_id, state: "HELD" });
    expect((await stockOf(db, s.products.A!)).reserved).toBe(4);
  });

  it("five simultaneous reserves of one purchase make one reservation and hold once", async () => {
    const s = await stockedChain(db, { A: 10 });
    const line = [{ product_id: s.products.A!, quantity: 4 }];
    const results = await Promise.all(Array.from({ length: 5 }, () => reserve(db, s.chain.purchaseId, line)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => r.reservation_id)).size).toBe(1);
    expect(results.filter((r) => r.already === false)).toHaveLength(1);
    expect((await stockOf(db, s.products.A!)).reserved).toBe(4);
    expect(await discrepancies(db, ids(s.products))).toEqual([]);
  });

  it("twenty parallel reservations of 7 against 50 units: exactly 7 fit and allocation never exceeds stock", async () => {
    const s = await stockedChain(db, { A: 50 });
    const buyers = [s.chain.purchaseId, ...(await Promise.all(Array.from({ length: 19 }, () => purchaseFor(db, s.merchantId))))];
    const results = await Promise.all(buyers.map((p) => reserve(db, p, [{ product_id: s.products.A!, quantity: 7 }])));

    expect(results.filter((r) => r.ok)).toHaveLength(7);
    expect(results.filter((r) => !r.ok && r.code === "INSUFFICIENT_STOCK")).toHaveLength(13);
    const stock = await stockOf(db, s.products.A!);
    expect(stock.reserved).toBe(49);
    expect(stock.reserved).toBeLessThanOrEqual(stock.on_hand);
    expect(await discrepancies(db, ids(s.products))).toEqual([]);
  });

  it("opposite-order multi-product reservations in parallel never deadlock", async () => {
    const s = await stockedChain(db, { A: 1000, B: 1000 });
    const buyers = await Promise.all(Array.from({ length: 24 }, (_, i) => (i === 0 ? s.chain.purchaseId : purchaseFor(db, s.merchantId))));
    const a = { product_id: s.products.A!, quantity: 3 };
    const b = { product_id: s.products.B!, quantity: 2 };
    const results = await Promise.all(buyers.map((p, i) => reserve(db, p, i % 2 === 0 ? [a, b] : [b, a])));
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await stockOf(db, s.products.A!)).reserved).toBe(72);
    expect((await stockOf(db, s.products.B!)).reserved).toBe(48);
    expect(await discrepancies(db, ids(s.products))).toEqual([]);
  });

  describe("input that is refused with INVALID_INPUT", () => {
    const refuse = async (mutate: (productId: string) => unknown, hold = 30) => {
      const s = await stockedChain(db, { A: 10 });
      const r = await reserve(db, s.chain.purchaseId, mutate(s.products.A!) as never, T0, hold);
      expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect(await reservationOf(db, s.chain.purchaseId)).toBeNull();
      expect((await stockOf(db, s.products.A!)).reserved).toBe(0);
    };

    it("no lines", () => refuse(() => []));
    it("not an array", () => refuse((p) => ({ product_id: p, quantity: 1 })));
    it("a zero quantity", () => refuse((p) => [{ product_id: p, quantity: 0 }]));
    it("a negative quantity", () => refuse((p) => [{ product_id: p, quantity: -2 }]));
    it("a fractional quantity", () => refuse((p) => [{ product_id: p, quantity: 1.5 }]));
    it("a missing quantity", () => refuse((p) => [{ product_id: p }]));
    it("a missing product id", () => refuse(() => [{ quantity: 1 }]));
    it("a repeated product", () => refuse((p) => [{ product_id: p, quantity: 1 }, { product_id: p, quantity: 2 }]));
    it("a hold window of zero minutes", () => refuse((p) => [{ product_id: p, quantity: 1 }], 0));

    it("a product that belongs to another merchant", async () => {
      const mine = await stockedChain(db, { A: 10 });
      const theirs = await stockedChain(db, { A: 10 });
      const r = await reserve(db, mine.chain.purchaseId, [{ product_id: theirs.products.A!, quantity: 1 }]);
      expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect((await stockOf(db, theirs.products.A!)).reserved).toBe(0);
    });
  });

  it("reports an unknown purchase as NOT_FOUND", async () => {
    expect(await reserve(db, unknownId(), [{ product_id: unknownId(), quantity: 1 }])).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("release_hold", () => {
  async function held(on = 10, quantity = 4) {
    const s = await stockedChain(db, { A: on });
    const r = await reserve(db, s.chain.purchaseId, [{ product_id: s.products.A!, quantity }]);
    return { ...s, reservationId: r.reservation_id!, productId: s.products.A! };
  }

  it.each(["SUPERSEDED", "ABANDONED"])("releases a HELD reservation for %s and gives the stock back", async (reason) => {
    const h = await held();
    const r = await releaseHold(db, h.reservationId, reason);
    expect(r).toMatchObject({ ok: true, already: false });
    expect(await reservationOf(db, h.chain.purchaseId)).toMatchObject({ state: "RELEASED", release_reason: reason });
    expect(await stockOf(db, h.productId)).toEqual({ on_hand: 10, reserved: 0 });
    expect(await discrepancies(db, [h.productId])).toEqual([]);
  });

  it("is idempotent: releasing twice changes stock once", async () => {
    const h = await held();
    await releaseHold(db, h.reservationId, "ABANDONED");
    expect(await releaseHold(db, h.reservationId, "ABANDONED")).toMatchObject({ ok: true, already: true });
    expect((await stockOf(db, h.productId)).reserved).toBe(0);
  });

  it("five simultaneous releases return the stock once", async () => {
    const h = await held();
    const other = await purchaseFor(db, h.merchantId);
    await reserve(db, other, [{ product_id: h.productId, quantity: 3 }]);
    await Promise.all(Array.from({ length: 5 }, () => releaseHold(db, h.reservationId, "ABANDONED")));
    expect((await stockOf(db, h.productId)).reserved).toBe(3);
    expect(await discrepancies(db, [h.productId])).toEqual([]);
  });

  it("EXPIRED only once the hold has expired, and then at exactly the expiry", async () => {
    const h = await held();
    expect(await releaseHold(db, h.reservationId, "EXPIRED", addMinutes(T0, 29))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await reservationOf(db, h.chain.purchaseId))!.state).toBe("HELD");
    expect(await releaseHold(db, h.reservationId, "EXPIRED", addMinutes(T0, 30))).toMatchObject({ ok: true });
    expect(await reservationOf(db, h.chain.purchaseId)).toMatchObject({ state: "RELEASED", release_reason: "EXPIRED" });
  });

  it.each(["DECLINED", "VOIDED", "WHATEVER"])("refuses the reason %s, which a plain release cannot give", async (reason) => {
    const h = await held();
    expect(await releaseHold(db, h.reservationId, reason)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await stockOf(db, h.productId)).reserved).toBe(4);
  });

  it("refuses a reservation that is in flight, and leaves stock held", async () => {
    const h = await held();
    must(await db.from("reservations").update({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "authorize" }).eq("id", h.reservationId));
    expect(await releaseHold(db, h.reservationId, "ABANDONED")).toMatchObject({ ok: false, code: "OPERATION_IN_FLIGHT" });
    expect(await reservationOf(db, h.chain.purchaseId)).toMatchObject({ state: "PAYMENT_IN_FLIGHT" });
    expect((await stockOf(db, h.productId)).reserved).toBe(4);
  });

  it("refuses a reservation awaiting confirmation, and leaves stock held", async () => {
    const h = await held();
    must(await db.from("reservations").update({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "authorize" }).eq("id", h.reservationId));
    must(await db.from("reservations").update({ state: "AWAITING_CONFIRMATION", in_flight_operation: null }).eq("id", h.reservationId));
    expect(await releaseHold(db, h.reservationId, "ABANDONED")).toMatchObject({ ok: false, code: "NOT_HELD" });
    expect((await stockOf(db, h.productId)).reserved).toBe(4);
  });

  it("reports an unknown reservation as NOT_FOUND", async () => {
    expect(await releaseHold(db, unknownId(), "ABANDONED")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("re-hold after an expiry", () => {
  async function expired() {
    const s = await stockedChain(db, { A: 10 });
    const line = [{ product_id: s.products.A!, quantity: 4 }];
    const r = await reserve(db, s.chain.purchaseId, line);
    await releaseHold(db, r.reservation_id!, "EXPIRED", addMinutes(T0, 31));
    return { ...s, line, reservationId: r.reservation_id!, productId: s.products.A! };
  }

  it("takes up the same reservation again with a new expiry, holding stock once more", async () => {
    const e = await expired();
    const later = addMinutes(T0, 45);
    const r = await reserve(db, e.chain.purchaseId, e.line, later);
    expect(r).toMatchObject({ ok: true, already: false, reheld: true, reservation_id: e.reservationId });
    expect(await reservationOf(db, e.chain.purchaseId)).toMatchObject({ state: "HELD", release_reason: null });
    expect(new Date((await reservationOf(db, e.chain.purchaseId))!.expires_at!).toISOString()).toBe(addMinutes(later, 30));
    expect((await stockOf(db, e.productId)).reserved).toBe(4);
    expect(must(await db.from("reservation_lines").select("id").eq("reservation_id", e.reservationId))).toHaveLength(1);
    expect(await discrepancies(db, [e.productId])).toEqual([]);
  });

  it("fails with INSUFFICIENT_STOCK if someone else took the stock, and stays released", async () => {
    const e = await expired();
    const other = await purchaseFor(db, e.merchantId);
    await reserve(db, other, [{ product_id: e.productId, quantity: 8 }]);
    const r = await reserve(db, e.chain.purchaseId, e.line, addMinutes(T0, 45));
    expect(r).toMatchObject({ ok: false, code: "INSUFFICIENT_STOCK", shortages: [{ needed: 4, available: 2 }] });
    expect(await reservationOf(db, e.chain.purchaseId)).toMatchObject({ state: "RELEASED", release_reason: "EXPIRED" });
    expect((await stockOf(db, e.productId)).reserved).toBe(8);
  });

  it("is refused while the purchase has an active payment attempt", async () => {
    const e = await expired();
    must(await db.from("payment_attempts").insert({ purchase_id: e.chain.purchaseId, amount_minor: 100, quote_hash: e.chain.quoteHash, state: "CREATED" }));
    expect(await reserve(db, e.chain.purchaseId, e.line, addMinutes(T0, 45))).toMatchObject({ ok: false, code: "PAYMENT_ACTIVE" });
  });

  it("is allowed once the earlier attempt has ended", async () => {
    const e = await expired();
    must(await db.from("payment_attempts").insert({ purchase_id: e.chain.purchaseId, amount_minor: 100, quote_hash: e.chain.quoteHash, state: "FAILED" }));
    expect(await reserve(db, e.chain.purchaseId, e.line, addMinutes(T0, 45))).toMatchObject({ ok: true, reheld: true });
  });

  it("is refused with different lines than the reservation had", async () => {
    const e = await expired();
    const r = await reserve(db, e.chain.purchaseId, [{ product_id: e.productId, quantity: 5 }], addMinutes(T0, 45));
    expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it.each(["SUPERSEDED", "ABANDONED"])("is not possible after a %s release, which is final", async (reason) => {
    const s = await stockedChain(db, { A: 10 });
    const line = [{ product_id: s.products.A!, quantity: 4 }];
    const r = await reserve(db, s.chain.purchaseId, line);
    await releaseHold(db, r.reservation_id!, reason);
    expect(await reserve(db, s.chain.purchaseId, line, addMinutes(T0, 5))).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect((await stockOf(db, s.products.A!)).reserved).toBe(0);
  });
});

describe("function privileges", () => {
  it.each([
    ["reserve_stock", { p_purchase_id: unknownId(), p_lines: [], p_now: T0, p_hold_minutes: 30 }],
    ["release_hold", { p_reservation_id: unknownId(), p_reason: "ABANDONED", p_now: T0 }],
  ])("%s cannot be called by the anon role", async (fn, args) => {
    expect(codeOf(await anonClient().rpc(fn, args))).toBe(SQLSTATE.denied);
  });

  it("the internal stock helper cannot be called by the anon role either", async () => {
    expect(codeOf(await anonClient().rpc("reservation_apply_stock", { p_reservation_id: unknownId(), p_effect: "RESERVE" }))).toBe(SQLSTATE.denied);
  });

  it("nor by the service role through the API: it is an internal helper", async () => {
    // Only the other RPCs (which run as the function owner) may use it.
    const r = await db.rpc("reservation_apply_stock", { p_reservation_id: unknownId(), p_effect: "RESERVE" });
    expect(codeOf(r)).toBe(SQLSTATE.denied);
  });
});
