// Real local Postgres. Evidence label for this file: local database, not mocked.
import { describe, expect, it } from "vitest";
import { anonClient, codeOf, serviceClient, SQLSTATE } from "./helpers";
import {
  T0,
  addMinutes,
  call,
  discrepancies,
  purchaseFor,
  releaseHold,
  reservationOf,
  reserve,
  stockOf,
  stockedChain,
  unknownId,
} from "./reservation-helpers";

const db = serviceClient();

const begin = (id: string, operation: string, now = T0) => call(db, "begin_operation", { p_reservation_id: id, p_operation: operation, p_now: now });
const settle = (id: string, outcome: string, now = T0, extra: Record<string, unknown> = {}) =>
  call(db, "settle_operation", { p_reservation_id: id, p_outcome: outcome, p_now: now, ...extra });
const resolve = (id: string, target: string, evidence: string, now = T0, extra: Record<string, unknown> = {}) =>
  call(db, "resolve_review", { p_reservation_id: id, p_target: target, p_evidence: evidence, p_now: now, ...extra });

/** A HELD reservation of `quantity` units of one product with `onHand` in stock. */
async function held(onHand = 10, quantity = 4) {
  const s = await stockedChain(db, { A: onHand });
  const r = await reserve(db, s.chain.purchaseId, [{ product_id: s.products.A!, quantity }]);
  const productId = s.products.A!;
  return { ...s, reservationId: r.reservation_id!, productId, quantity, state: () => reservationOf(db, s.chain.purchaseId), stock: () => stockOf(db, productId) };
}
type Held = Awaited<ReturnType<typeof held>>;

async function awaiting(h?: Held) {
  const r = h ?? (await held());
  await begin(r.reservationId, "authorize");
  await settle(r.reservationId, "AUTHORIZED");
  return r;
}

async function inFlight(operation: "authorize" | "capture" | "void") {
  const r = operation === "authorize" ? await held() : await awaiting();
  await begin(r.reservationId, operation);
  return r;
}

describe("begin_operation", () => {
  it("authorize moves a HELD reservation to PAYMENT_IN_FLIGHT and records the operation", async () => {
    const h = await held();
    expect(await begin(h.reservationId, "authorize", addMinutes(T0, 5))).toMatchObject({ ok: true, state: "PAYMENT_IN_FLIGHT" });
    expect(await h.state()).toMatchObject({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "authorize" });
    expect(new Date((await h.state())!.state_changed_at).toISOString()).toBe(addMinutes(T0, 5));
    expect((await h.stock()).reserved).toBe(4);
  });

  it.each(["capture", "void"])("%s moves an AWAITING_CONFIRMATION reservation to PAYMENT_IN_FLIGHT", async (operation) => {
    const h = await awaiting();
    expect(await begin(h.reservationId, operation)).toMatchObject({ ok: true });
    expect(await h.state()).toMatchObject({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: operation });
  });

  it("refuses anything else with a coded reason", async () => {
    const h = await held();
    expect(await begin(h.reservationId, "capture")).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(await begin(h.reservationId, "void")).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });

    const a = await awaiting();
    expect(await begin(a.reservationId, "authorize")).toMatchObject({ ok: false, code: "NOT_HELD" });

    const released = await held();
    await releaseHold(db, released.reservationId, "ABANDONED");
    expect(await begin(released.reservationId, "authorize")).toMatchObject({ ok: false, code: "NOT_HELD" });

    const committed = await awaiting();
    await begin(committed.reservationId, "capture");
    await settle(committed.reservationId, "CAPTURED");
    expect(await begin(committed.reservationId, "capture")).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });

  it("refuses a second operation while one is in flight, including the same one", async () => {
    const h = await inFlight("authorize");
    expect(await begin(h.reservationId, "authorize")).toMatchObject({ ok: false, code: "OPERATION_IN_FLIGHT", operation: "authorize" });
    expect(await begin(h.reservationId, "capture")).toMatchObject({ ok: false, code: "OPERATION_IN_FLIGHT" });
  });

  it("refuses an unknown operation and an unknown reservation", async () => {
    const h = await held();
    expect(await begin(h.reservationId, "refund")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await begin(unknownId(), "authorize")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("an authorize on an expired hold releases it and reports HOLD_EXPIRED, at exactly the expiry", async () => {
    const before = await held();
    expect(await begin(before.reservationId, "authorize", "2026-11-03T10:29:59.999Z")).toMatchObject({ ok: true });

    const h = await held();
    const r = await begin(h.reservationId, "authorize", addMinutes(T0, 30));
    expect(r).toMatchObject({ ok: false, code: "HOLD_EXPIRED" });
    expect(await h.state()).toMatchObject({ state: "RELEASED", release_reason: "EXPIRED" });
    expect((await h.stock()).reserved).toBe(0);
    expect(await discrepancies(db, [h.productId])).toEqual([]);
  });

  it("five simultaneous begins on one reservation have exactly one winner", async () => {
    const h = await held();
    const results = await Promise.all(Array.from({ length: 5 }, () => begin(h.reservationId, "authorize")));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.code === "OPERATION_IN_FLIGHT")).toHaveLength(4);
  });

  it("a release racing a begin has exactly one winner, and stock matches the winner", async () => {
    for (let i = 0; i < 8; i++) {
      const h = await held();
      const [b, r] = await Promise.all([begin(h.reservationId, "authorize"), releaseHold(db, h.reservationId, "ABANDONED")]);
      expect(b.ok !== r.ok || (b.ok && r.ok === false)).toBe(true);
      expect(Number(b.ok) + Number(r.ok)).toBe(1);
      if (b.ok) {
        expect(r.code).toBe("OPERATION_IN_FLIGHT");
        expect(await h.state()).toMatchObject({ state: "PAYMENT_IN_FLIGHT" });
        expect((await h.stock()).reserved).toBe(4);
      } else {
        expect(b.code).toBe("NOT_HELD");
        expect(await h.state()).toMatchObject({ state: "RELEASED" });
        expect((await h.stock()).reserved).toBe(0);
      }
      expect(await discrepancies(db, [h.productId])).toEqual([]);
    }
  });
});

describe("settle_operation", () => {
  it("demo step C and D: a timer cannot release a reservation in flight or awaiting confirmation", async () => {
    const h = await inFlight("authorize");
    const late = addMinutes(T0, 120);
    expect(await releaseHold(db, h.reservationId, "EXPIRED", late)).toMatchObject({ ok: false, code: "OPERATION_IN_FLIGHT" });
    expect(await h.state()).toMatchObject({ state: "PAYMENT_IN_FLIGHT" });

    expect(await settle(h.reservationId, "AUTHORIZED", late)).toMatchObject({ ok: true, state: "AWAITING_CONFIRMATION" });
    expect(await h.state()).toMatchObject({ state: "AWAITING_CONFIRMATION", in_flight_operation: null });
    expect(await releaseHold(db, h.reservationId, "EXPIRED", addMinutes(T0, 600))).toMatchObject({ ok: false, code: "NOT_HELD" });
    expect(await h.stock()).toEqual({ on_hand: 10, reserved: 4 });
  });

  it("demo step E: a declined order is voided and the stock comes back", async () => {
    const h = await awaiting();
    const before = await h.stock();
    await begin(h.reservationId, "void");
    expect(await settle(h.reservationId, "VOIDED", T0, { p_release_reason: "DECLINED" })).toMatchObject({ ok: true, state: "RELEASED" });
    expect(await h.state()).toMatchObject({ state: "RELEASED", release_reason: "DECLINED", in_flight_operation: null });
    expect(await h.stock()).toEqual({ on_hand: before.on_hand, reserved: 0 });
    expect(before.on_hand - (await h.stock()).reserved).toBe(10); // available is what it was before the hold
    expect(await discrepancies(db, [h.productId])).toEqual([]);
  });

  it("a void settles as VOIDED by default, and refuses a reason a void cannot have", async () => {
    const h = await awaiting();
    await begin(h.reservationId, "void");
    expect(await settle(h.reservationId, "VOIDED", T0, { p_release_reason: "EXPIRED" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await h.state()).toMatchObject({ state: "PAYMENT_IN_FLIGHT" });
    expect(await settle(h.reservationId, "VOIDED")).toMatchObject({ ok: true });
    expect(await h.state()).toMatchObject({ release_reason: "VOIDED" });
  });

  it("demo step F: a captured order commits the stock, lowering on_hand and reserved together", async () => {
    const h = await awaiting();
    const before = await h.stock();
    await begin(h.reservationId, "capture");
    expect(await settle(h.reservationId, "CAPTURED")).toMatchObject({ ok: true, state: "COMMITTED" });
    expect(await h.state()).toMatchObject({ state: "COMMITTED", in_flight_operation: null });
    const after = await h.stock();
    expect(after).toEqual({ on_hand: 6, reserved: 0 });
    // Available is unchanged by a commit: the units left the shelf instead of being held on it.
    expect(after.on_hand - after.reserved).toBe(before.on_hand - before.reserved);
    expect(await discrepancies(db, [h.productId])).toEqual([]);
  });

  it("AUTHORIZE_FAILED returns to HELD with a new hold window and keeps the stock held", async () => {
    const h = await inFlight("authorize");
    const later = addMinutes(T0, 20);
    expect(await settle(h.reservationId, "AUTHORIZE_FAILED", later, { p_hold_minutes: 15 })).toMatchObject({ ok: true, state: "HELD" });
    const row = await h.state();
    expect(row).toMatchObject({ state: "HELD", in_flight_operation: null });
    expect(new Date(row!.expires_at!).toISOString()).toBe(addMinutes(later, 15));
    expect((await h.stock()).reserved).toBe(4);
  });

  it.each([
    ["capture", "CAPTURE_FAILED"],
    ["void", "VOID_FAILED"],
  ] as const)("%s failing returns to AWAITING_CONFIRMATION and keeps the stock held", async (operation, outcome) => {
    const h = await inFlight(operation);
    expect(await settle(h.reservationId, outcome)).toMatchObject({ ok: true, state: "AWAITING_CONFIRMATION" });
    expect(await h.state()).toMatchObject({ state: "AWAITING_CONFIRMATION", in_flight_operation: null });
    expect(await h.stock()).toEqual({ on_hand: 10, reserved: 4 });
  });

  it.each(["authorize", "capture", "void"] as const)("demo step H: an unknown %s outcome goes to REVIEW_REQUIRED and keeps the stock held", async (operation) => {
    const h = await inFlight(operation);
    expect(await settle(h.reservationId, "UNKNOWN", T0, { p_reason: "timeout after 30s" })).toMatchObject({ ok: true, state: "REVIEW_REQUIRED" });
    expect(await h.state()).toMatchObject({ state: "REVIEW_REQUIRED", in_flight_operation: null, review_reason: "timeout after 30s" });
    expect(await h.stock()).toEqual({ on_hand: 10, reserved: 4 });
    expect(await discrepancies(db, [h.productId])).toEqual([]);
  });

  it("refuses an outcome that does not fit the recorded operation, and leaves the reservation in flight", async () => {
    const h = await inFlight("capture");
    for (const outcome of ["AUTHORIZED", "AUTHORIZE_FAILED", "VOIDED", "VOID_FAILED"]) {
      expect(await settle(h.reservationId, outcome), outcome).toMatchObject({ ok: false, code: "OUTCOME_MISMATCH" });
    }
    expect(await h.state()).toMatchObject({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "capture" });
    expect(await h.stock()).toEqual({ on_hand: 10, reserved: 4 });
  });

  it("refuses when no operation is in flight", async () => {
    const h = await held();
    expect(await settle(h.reservationId, "AUTHORIZED")).toMatchObject({ ok: false, code: "NO_OPERATION_IN_FLIGHT" });
    const a = await awaiting();
    expect(await settle(a.reservationId, "CAPTURE_FAILED")).toMatchObject({ ok: false, code: "NO_OPERATION_IN_FLIGHT" });
  });

  it("repeating a success outcome returns the same result and changes stock once", async () => {
    const h = await awaiting();
    await begin(h.reservationId, "capture");
    const first = await settle(h.reservationId, "CAPTURED");
    const again = await settle(h.reservationId, "CAPTURED");
    expect(first).toMatchObject({ ok: true, already: false });
    expect(again).toMatchObject({ ok: true, already: true, state: "COMMITTED" });
    expect(await h.stock()).toEqual({ on_hand: 6, reserved: 0 });
  });

  it("five simultaneous CAPTURED settlements commit the stock once", async () => {
    const h = await awaiting();
    await begin(h.reservationId, "capture");
    const results = await Promise.all(Array.from({ length: 5 }, () => settle(h.reservationId, "CAPTURED")));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.already === false)).toHaveLength(1);
    expect(await h.stock()).toEqual({ on_hand: 6, reserved: 0 });
  });

  it("five simultaneous VOIDED settlements release the stock once", async () => {
    const h = await awaiting();
    const other = await purchaseFor(db, h.merchantId);
    await reserve(db, other, [{ product_id: h.productId, quantity: 3 }]);
    await begin(h.reservationId, "void");
    await Promise.all(Array.from({ length: 5 }, () => settle(h.reservationId, "VOIDED")));
    expect(await h.stock()).toEqual({ on_hand: 10, reserved: 3 });
    expect(await discrepancies(db, [h.productId])).toEqual([]);
  });

  it("repeating a failure outcome is not treated as success", async () => {
    const h = await inFlight("capture");
    await settle(h.reservationId, "CAPTURE_FAILED");
    expect(await settle(h.reservationId, "CAPTURE_FAILED")).toMatchObject({ ok: false, code: "NO_OPERATION_IN_FLIGHT" });
  });

  it("refuses an unknown outcome, a bad hold window, and an unknown reservation", async () => {
    const h = await inFlight("authorize");
    expect(await settle(h.reservationId, "PAID")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await settle(h.reservationId, "AUTHORIZE_FAILED", T0, { p_hold_minutes: 0 })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await h.state()).toMatchObject({ state: "PAYMENT_IN_FLIGHT" });
    expect(await settle(unknownId(), "AUTHORIZED")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("the whole lifecycle ends consistent: reserve, authorize, hold, capture", async () => {
    const h = await held(100, 30);
    await begin(h.reservationId, "authorize");
    await settle(h.reservationId, "AUTHORIZED");
    expect(await h.stock()).toEqual({ on_hand: 100, reserved: 30 });
    await begin(h.reservationId, "capture");
    await settle(h.reservationId, "CAPTURED");
    expect(await h.stock()).toEqual({ on_hand: 70, reserved: 0 });
    expect(await discrepancies(db, [h.productId])).toEqual([]);
  });
});

describe("resolve_review", () => {
  async function inReview() {
    const h = await inFlight("capture");
    await settle(h.reservationId, "UNKNOWN", T0, { p_reason: "timeout" });
    return h;
  }

  it("HELD: the hold restarts and the stock stays held", async () => {
    const h = await inReview();
    const now = addMinutes(T0, 60);
    expect(await resolve(h.reservationId, "HELD", "PayPal shows no authorization", now, { p_hold_minutes: 20 })).toMatchObject({ ok: true, state: "HELD" });
    const row = await h.state();
    expect(row).toMatchObject({ state: "HELD", review_reason: "PayPal shows no authorization" });
    expect(new Date(row!.expires_at!).toISOString()).toBe(addMinutes(now, 20));
    expect(await h.stock()).toEqual({ on_hand: 10, reserved: 4 });
  });

  it("AWAITING_CONFIRMATION: back to waiting for the merchant, stock held", async () => {
    const h = await inReview();
    expect(await resolve(h.reservationId, "AWAITING_CONFIRMATION", "PayPal shows authorized, not captured")).toMatchObject({ ok: true });
    expect(await h.state()).toMatchObject({ state: "AWAITING_CONFIRMATION" });
    expect(await h.stock()).toEqual({ on_hand: 10, reserved: 4 });
  });

  it("COMMITTED: the stock is committed once", async () => {
    const h = await inReview();
    expect(await resolve(h.reservationId, "COMMITTED", "PayPal shows capture COMPLETED")).toMatchObject({ ok: true, state: "COMMITTED" });
    expect(await h.stock()).toEqual({ on_hand: 6, reserved: 0 });
    expect(await discrepancies(db, [h.productId])).toEqual([]);
  });

  it("RELEASED needs a reason and gives the stock back", async () => {
    const h = await inReview();
    expect(await resolve(h.reservationId, "RELEASED", "PayPal shows the authorization voided")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await h.state()).toMatchObject({ state: "REVIEW_REQUIRED" });
    expect(await resolve(h.reservationId, "RELEASED", "PayPal shows the authorization voided", T0, { p_release_reason: "VOIDED" })).toMatchObject({ ok: true, state: "RELEASED" });
    expect(await h.state()).toMatchObject({ state: "RELEASED", release_reason: "VOIDED" });
    expect(await h.stock()).toEqual({ on_hand: 10, reserved: 0 });
  });

  it("repeating the same resolution changes stock once", async () => {
    const h = await inReview();
    await resolve(h.reservationId, "COMMITTED", "capture confirmed");
    expect(await resolve(h.reservationId, "COMMITTED", "capture confirmed")).toMatchObject({ ok: true, already: true });
    expect(await h.stock()).toEqual({ on_hand: 6, reserved: 0 });
  });

  it("a commit and a release racing: one wins, never both, and stock changes once", async () => {
    for (let i = 0; i < 6; i++) {
      const h = await inReview();
      const [c, r] = await Promise.all([
        resolve(h.reservationId, "COMMITTED", "capture confirmed"),
        resolve(h.reservationId, "RELEASED", "void confirmed", T0, { p_release_reason: "VOIDED" }),
      ]);
      expect(Number(c.ok) + Number(r.ok)).toBe(1);
      const stock = await h.stock();
      expect(c.ok ? stock : { on_hand: 10, reserved: 0 }).toEqual(c.ok ? { on_hand: 6, reserved: 0 } : stock);
      expect(await h.state()).toMatchObject({ state: c.ok ? "COMMITTED" : "RELEASED" });
      expect(await discrepancies(db, [h.productId])).toEqual([]);
    }
  });

  it("only leaves REVIEW_REQUIRED", async () => {
    const h = await held();
    expect(await resolve(h.reservationId, "RELEASED", "x", T0, { p_release_reason: "ABANDONED" })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(await h.state()).toMatchObject({ state: "HELD" });
    expect((await h.stock()).reserved).toBe(4);
  });

  it("refuses a bad target, blank evidence and an unknown reservation", async () => {
    const h = await inReview();
    expect(await resolve(h.reservationId, "PAYMENT_IN_FLIGHT", "x")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await resolve(h.reservationId, "REVIEW_REQUIRED", "x")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await resolve(h.reservationId, "HELD", "   ")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await resolve(h.reservationId, "HELD", "x".repeat(201))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await h.state()).toMatchObject({ state: "REVIEW_REQUIRED" });
    expect(await resolve(unknownId(), "HELD", "x")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("function privileges", () => {
  it.each([
    ["begin_operation", { p_reservation_id: unknownId(), p_operation: "authorize", p_now: T0 }],
    ["settle_operation", { p_reservation_id: unknownId(), p_outcome: "AUTHORIZED", p_now: T0 }],
    ["resolve_review", { p_reservation_id: unknownId(), p_target: "HELD", p_evidence: "x", p_now: T0 }],
  ])("%s cannot be called by the anon role", async (fn, args) => {
    expect(codeOf(await anonClient().rpc(fn, args))).toBe(SQLSTATE.denied);
  });
});
