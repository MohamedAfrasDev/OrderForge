// Real local Postgres. Evidence label for this file: local database, not mocked.
import { beforeAll, describe, expect, it } from "vitest";
import { stockInvariant, type ReservationState } from "@/domain/reservation";
import { sweepReservations } from "@/services/reservation/sweep";
import { anonClient, codeOf, must, serviceClient, SQLSTATE } from "./helpers";
import {
  T0,
  acceptedChain,
  acceptedPurchaseFor,
  addMinutes,
  call,
  discrepancies,
  releaseHold,
  reservationOf,
  reserve,
  stockOf,
  unknownId,
} from "./reservation-helpers";

const db = serviceClient();

const begin = (id: string, operation: string, now = T0) => call(db, "begin_operation", { p_reservation_id: id, p_operation: operation, p_now: now });
const settle = (id: string, outcome: string, now = T0) => call(db, "settle_operation", { p_reservation_id: id, p_outcome: outcome, p_now: now });
const sweep = (now: string, minutes?: number) => call(db, "sweep_reservations", { p_now: now, ...(minutes === undefined ? {} : { p_inflight_review_minutes: minutes }) });

type Swept = { ok: boolean; changes: Array<{ reservation_id: string; kind: string; from: string; to: string; reason: string }> };
const swept = async (now: string, minutes?: number): Promise<Swept> => (await sweep(now, minutes)) as unknown as Swept;
const changeFor = (s: Swept, id: string) => s.changes.find((c) => c.reservation_id === id);

/** A reservation of 4 of 10 units, with an ACCEPTED quote, expiring 30 minutes after T0. */
async function held(onHand = 10) {
  const s = await acceptedChain(db, { A: onHand });
  const r = await reserve(db, s.chain.purchaseId, [{ product_id: s.products.A!, quantity: 4 }]);
  return { ...s, id: r.reservation_id!, productId: s.products.A!, state: () => reservationOf(db, s.chain.purchaseId), stock: () => stockOf(db, s.products.A!) };
}

async function inState(target: ReservationState) {
  const h = await held();
  if (target === "HELD") return h;
  await begin(h.id, "authorize");
  if (target === "PAYMENT_IN_FLIGHT") return h;
  await settle(h.id, "AUTHORIZED");
  if (target === "AWAITING_CONFIRMATION") return h;
  if (target === "REVIEW_REQUIRED") {
    await begin(h.id, "capture");
    await settle(h.id, "UNKNOWN");
    return h;
  }
  await begin(h.id, "capture");
  await settle(h.id, "CAPTURED");
  return h;
}

beforeAll(async () => {
  // Counts below are exact, so start from an empty application schema (the sweep is global).
  must(await db.rpc("demo_reset"), "demo_reset");
});

describe("sweep_reservations: expired holds", () => {
  it("demo step G: releases a plain hold at exactly its expiry and gives the stock back", async () => {
    const h = await held();
    const justBefore = await swept("2026-11-03T10:29:59.999Z");
    expect(changeFor(justBefore, h.id)).toBeUndefined();
    expect((await h.state())!.state).toBe("HELD");

    const s = await swept(addMinutes(T0, 30));
    expect(changeFor(s, h.id)).toMatchObject({ kind: "expired", from: "HELD", to: "RELEASED", reason: "EXPIRED" });
    expect(await h.state()).toMatchObject({ state: "RELEASED", release_reason: "EXPIRED" });
    expect(await h.stock()).toEqual({ on_hand: 10, reserved: 0 });
    expect(await discrepancies(db, [h.productId])).toEqual([]);
  });

  it("is idempotent: a second sweep changes nothing", async () => {
    const h = await held();
    await sweep(addMinutes(T0, 60));
    const again = await swept(addMinutes(T0, 61));
    expect(changeFor(again, h.id)).toBeUndefined();
    expect((await h.stock()).reserved).toBe(0);
  });

  it("an expired hold can be taken up again afterwards, if the stock is still there", async () => {
    const h = await held();
    await sweep(addMinutes(T0, 45));
    const r = await reserve(db, h.chain.purchaseId, [{ product_id: h.productId, quantity: 4 }], addMinutes(T0, 46));
    expect(r).toMatchObject({ ok: true, reheld: true });
  });
});

describe("sweep_reservations: nothing in flight is ever released by a timer", () => {
  it("demo step C: a reservation in flight past its expiry is left alone, and its stock stays held", async () => {
    const h = await inState("PAYMENT_IN_FLIGHT");
    const s = await swept(addMinutes(T0, 25)); // past nothing: only the in-flight limit applies later
    expect(changeFor(s, h.id)).toBeUndefined();
    const later = await swept(addMinutes(T0, 29)); // still inside the 30-minute in-flight limit, and the hold itself ended at 30
    expect(changeFor(later, h.id)).toBeUndefined();
    expect(await h.state()).toMatchObject({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "authorize" });
    expect((await h.stock()).reserved).toBe(4);
  });

  it.each(["AWAITING_CONFIRMATION", "COMMITTED", "REVIEW_REQUIRED"] as const)("%s is never touched, however late the sweep runs", async (state) => {
    const h = await inState(state);
    const before = await h.state();
    const stockBefore = await h.stock();
    const s = await swept(addMinutes(T0, 100000));
    expect(changeFor(s, h.id)).toBeUndefined();
    expect((await h.state())!.state).toBe(before!.state);
    expect(await h.stock()).toEqual(stockBefore);
  });
});

describe("sweep_reservations: stale in-flight work goes to review", () => {
  it("moves an operation that has been in flight for the limit to REVIEW_REQUIRED and keeps the stock held", async () => {
    const h = await inState("PAYMENT_IN_FLIGHT");
    expect(changeFor(await swept("2026-11-03T10:29:59.999Z"), h.id)).toBeUndefined();

    const s = await swept(addMinutes(T0, 30));
    expect(changeFor(s, h.id)).toMatchObject({ kind: "stale", from: "PAYMENT_IN_FLIGHT", to: "REVIEW_REQUIRED" });
    expect(await h.state()).toMatchObject({ state: "REVIEW_REQUIRED", in_flight_operation: null });
    expect((await h.state())!.review_reason).toMatch(/still in flight/);
    expect(await h.stock()).toEqual({ on_hand: 10, reserved: 4 });
    expect(await discrepancies(db, [h.productId])).toEqual([]);
  });

  it("uses the limit passed in", async () => {
    const h = await inState("PAYMENT_IN_FLIGHT");
    expect(changeFor(await swept(addMinutes(T0, 9), 10), h.id)).toBeUndefined();
    expect(changeFor(await swept(addMinutes(T0, 10), 10), h.id)).toMatchObject({ to: "REVIEW_REQUIRED" });
  });

  it("uses the merchant's inflight_review_minutes rule when it is set, and ignores a malformed one", async () => {
    const a = await inState("PAYMENT_IN_FLIGHT");
    must(await db.from("business_rules").insert({ merchant_id: a.merchantId, key: "inflight_review_minutes", value: { minutes: 5 } }));
    expect(changeFor(await swept(addMinutes(T0, 5)), a.id)).toMatchObject({ to: "REVIEW_REQUIRED" });

    const b = await inState("PAYMENT_IN_FLIGHT");
    must(await db.from("business_rules").insert({ merchant_id: b.merchantId, key: "inflight_review_minutes", value: { minutes: "soon" } }));
    expect(changeFor(await swept(addMinutes(T0, 5)), b.id)).toBeUndefined();
    expect(changeFor(await swept(addMinutes(T0, 30)), b.id)).toMatchObject({ to: "REVIEW_REQUIRED" });
  });
});

describe("sweep_reservations: reservations whose quote is no longer accepted", () => {
  async function superseded(target: ReservationState) {
    const h = await inState(target);
    must(await db.from("quote_versions").update({ status: "SUPERSEDED" }).eq("id", h.chain.quoteId));
    return h;
  }

  it("releases a HELD reservation as SUPERSEDED and gives the stock back", async () => {
    const h = await superseded("HELD");
    const s = await swept(addMinutes(T0, 1));
    expect(changeFor(s, h.id)).toMatchObject({ kind: "orphan", from: "HELD", to: "RELEASED", reason: "SUPERSEDED" });
    expect(await h.state()).toMatchObject({ state: "RELEASED", release_reason: "SUPERSEDED" });
    expect(await h.stock()).toEqual({ on_hand: 10, reserved: 0 });
  });

  it.each(["PAYMENT_IN_FLIGHT", "AWAITING_CONFIRMATION"] as const)("flags a %s reservation for review instead, because money may be involved", async (state) => {
    const h = await superseded(state);
    const s = await swept(addMinutes(T0, 1));
    expect(changeFor(s, h.id)).toMatchObject({ kind: "orphan", from: state, to: "REVIEW_REQUIRED" });
    expect(await h.state()).toMatchObject({ state: "REVIEW_REQUIRED" });
    expect((await h.state())!.review_reason).toMatch(/no longer accepted/);
    expect(await h.stock()).toEqual({ on_hand: 10, reserved: 4 });
  });

  it("leaves COMMITTED and REVIEW_REQUIRED alone", async () => {
    for (const state of ["COMMITTED", "REVIEW_REQUIRED"] as const) {
      const h = await superseded(state);
      expect(changeFor(await swept(addMinutes(T0, 1)), h.id), state).toBeUndefined();
    }
  });

  it("leaves a HELD reservation of an ACCEPTED quote alone", async () => {
    const h = await held();
    expect(changeFor(await swept(addMinutes(T0, 1)), h.id)).toBeUndefined();
    expect((await h.state())!.state).toBe("HELD");
  });
});

describe("sweep_reservations: races", () => {
  it("a sweep racing begin_operation has exactly one winner and never releases an in-flight hold", async () => {
    for (let i = 0; i < 10; i++) {
      const h = await held();
      // begin_operation judges the hold at T0+10 (not expired); the sweep judges it at T0+31 (expired).
      const [b] = await Promise.all([begin(h.id, "authorize", addMinutes(T0, 10)), sweep(addMinutes(T0, 31))]);
      const row = await h.state();
      if (b.ok) {
        // begin won: the reservation is in flight, the sweep did not touch it, stock is still held.
        expect(row).toMatchObject({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "authorize" });
        expect((await h.stock()).reserved).toBe(4);
      } else {
        // the sweep won first: released once, and begin saw a released hold.
        expect(b.code).toBe("NOT_HELD");
        expect(row).toMatchObject({ state: "RELEASED", release_reason: "EXPIRED" });
        expect((await h.stock()).reserved).toBe(0);
      }
      expect(await discrepancies(db, [h.productId])).toEqual([]);
    }
  });

  it("two sweeps at once release each hold once", async () => {
    const hs = await Promise.all([held(), held(), held()]);
    await Promise.all([sweep(addMinutes(T0, 40)), sweep(addMinutes(T0, 40)), sweep(addMinutes(T0, 40))]);
    for (const h of hs) {
      expect(await h.stock()).toEqual({ on_hand: 10, reserved: 0 });
      expect((await h.state())!.state).toBe("RELEASED");
    }
  });

  it("a sweep racing a release_hold on the same hold changes stock once", async () => {
    for (let i = 0; i < 6; i++) {
      const h = await held();
      await Promise.all([sweep(addMinutes(T0, 40)), releaseHold(db, h.id, "EXPIRED", addMinutes(T0, 40))]);
      expect(await h.stock()).toEqual({ on_hand: 10, reserved: 0 });
    }
  });
});

describe("sweep_reservations: a hold with an accounting error does not stop the others", () => {
  it("leaves the broken hold alone, reports it, and still releases the healthy one", async () => {
    const bad = await held();
    const good = await held();
    // Stock says nothing is reserved, so giving 4 units back would go below zero: an accounting error.
    must(await db.from("stock").update({ reserved: 0 }).eq("product_id", bad.productId));
    try {
      const r = (await sweep(addMinutes(T0, 40))) as unknown as { ok: boolean; changes: Swept["changes"]; errors: Array<{ reservation_id: string; kind: string; reason: string }> };
      expect(r.ok).toBe(true);
      expect(r.changes.map((c) => c.reservation_id)).toContain(good.id);
      expect(r.changes.map((c) => c.reservation_id)).not.toContain(bad.id);
      expect(r.errors).toEqual([expect.objectContaining({ reservation_id: bad.id, kind: "expired" })]);
      expect(r.errors[0]!.reason).toMatch(/stock accounting error/);

      expect((await good.state())!.state).toBe("RELEASED");
      expect(await good.stock()).toEqual({ on_hand: 10, reserved: 0 });
      expect((await bad.state())!.state).toBe("HELD"); // untouched, not half-released
    } finally {
      must(await db.from("stock").update({ reserved: 4 }).eq("product_id", bad.productId));
    }
    // Once the accounting is repaired, the next sweep releases it normally.
    const again = await swept(addMinutes(T0, 41));
    expect(changeFor(again, bad.id)).toMatchObject({ to: "RELEASED", reason: "EXPIRED" });
    expect(await bad.stock()).toEqual({ on_hand: 10, reserved: 0 });
  });

  it("the service audits the error, finishes the rest, then throws so the scheduler shows a failed run", async () => {
    const bad = await held();
    const good = await held();
    must(await db.from("stock").update({ reserved: 0 }).eq("product_id", bad.productId));
    try {
      await expect(sweepReservations(db, { now: addMinutes(T0, 50), correlationId: "corr-sweep-error" })).rejects.toThrow(/accounting error/);
      expect((await good.state())!.state).toBe("RELEASED");
      const events = must(await db.from("audit_events").select("action, data").eq("entity", "reservation").eq("entity_id", bad.id).eq("correlation_id", "corr-sweep-error"));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "reservation.sweep_error" });
      expect(events[0]!.data).toMatchObject({ reservation_id: bad.id, from: "HELD" });
      const goodEvents = must(await db.from("audit_events").select("action").eq("entity_id", good.id).eq("correlation_id", "corr-sweep-error"));
      expect(goodEvents).toEqual([{ action: "reservation.released" }]);
    } finally {
      must(await db.from("stock").update({ reserved: 4 }).eq("product_id", bad.productId));
    }
    await sweep(addMinutes(T0, 51));
  });
});

describe("sweep_reservations: input and privileges", () => {
  it("refuses a bad limit", async () => {
    expect(await call(db, "sweep_reservations", { p_now: T0, p_inflight_review_minutes: 0 })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("cannot be called by the anon role", async () => {
    expect(codeOf(await anonClient().rpc("sweep_reservations", { p_now: T0 }))).toBe(SQLSTATE.denied);
  });
});

describe("check_stock_invariants", () => {
  const invariants = async (productIds?: string[]) =>
    must(await db.rpc("check_stock_invariants", productIds ? { p_product_ids: productIds } : {})) as unknown as Array<Record<string, unknown>>;

  it("is empty for a consistent state, and agrees with the pure invariant", async () => {
    const h = await inState("AWAITING_CONFIRMATION");
    expect(await invariants([h.productId])).toEqual([]);
    expect(await discrepancies(db, [h.productId])).toEqual([]);
  });

  it("finds reserved stock that no live reservation accounts for, and the pure invariant agrees", async () => {
    const h = await held();
    must(await db.from("stock").update({ reserved: 5 }).eq("product_id", h.productId)); // 4 is accounted for
    try {
      const found = await invariants([h.productId]);
      expect(found).toEqual([{ code: "RESERVED_MISMATCH", product_id: h.productId, reserved: 5, expected: 4 }]);

      const rows = must(await db.from("stock").select("product_id, on_hand, reserved").eq("product_id", h.productId));
      expect(
        stockInvariant(
          rows.map((r) => ({ productId: r.product_id as string, onHand: r.on_hand as number, reserved: r.reserved as number })),
          [{ productId: h.productId, quantity: 4 }],
        ),
      ).toEqual([{ code: "RESERVED_MISMATCH", productId: h.productId, reserved: 5, expected: 4 }]);
    } finally {
      must(await db.from("stock").update({ reserved: 4 }).eq("product_id", h.productId));
    }
    expect(await invariants([h.productId])).toEqual([]);
  });

  it("finds a live reservation that stock does not reflect", async () => {
    const h = await held();
    must(await db.from("stock").update({ reserved: 0 }).eq("product_id", h.productId));
    try {
      expect(await invariants([h.productId])).toEqual([{ code: "RESERVED_MISMATCH", product_id: h.productId, reserved: 0, expected: 4 }]);
    } finally {
      must(await db.from("stock").update({ reserved: 4 }).eq("product_id", h.productId));
    }
  });

  it("counts released and committed reservations as holding nothing", async () => {
    const released = await held();
    await sweep(addMinutes(T0, 60));
    expect(await invariants([released.productId])).toEqual([]);
    const committed = await inState("COMMITTED");
    expect(await invariants([committed.productId])).toEqual([]);
  });

  it("the whole demo path leaves stock consistent: reserve, authorize, hold, decline, capture, expire, unknown", async () => {
    const s = await acceptedChain(db, { A: 100 });
    const productId = s.products.A!;
    const other = await acceptedPurchaseFor(db, s.merchantId);
    const third = await acceptedPurchaseFor(db, s.merchantId);
    const line = (q: number) => [{ product_id: productId, quantity: q }];

    const r1 = await reserve(db, s.chain.purchaseId, line(30));
    const r2 = await reserve(db, other.purchaseId, line(20));
    const r3 = await reserve(db, third.purchaseId, line(10));
    expect(await invariants([productId])).toEqual([]);

    // r1: authorize, merchant accepts, capture
    await begin(r1.reservation_id!, "authorize");
    await settle(r1.reservation_id!, "AUTHORIZED");
    await begin(r1.reservation_id!, "capture");
    await settle(r1.reservation_id!, "CAPTURED");
    // r2: authorize, merchant declines, void
    await begin(r2.reservation_id!, "authorize");
    await settle(r2.reservation_id!, "AUTHORIZED");
    await begin(r2.reservation_id!, "void");
    await call(db, "settle_operation", { p_reservation_id: r2.reservation_id!, p_outcome: "VOIDED", p_now: T0, p_release_reason: "DECLINED" });
    // r3: never paid, expires
    await sweep(addMinutes(T0, 45));

    expect(await stockOf(db, productId)).toEqual({ on_hand: 70, reserved: 0 });
    expect(await invariants([productId])).toEqual([]);
    expect(await discrepancies(db, [productId])).toEqual([]);
    expect((await reservationOf(db, third.purchaseId))!.state).toBe("RELEASED");
    expect(r3.ok).toBe(true);
  });

  it("with no argument it looks at every product and returns an array", async () => {
    expect(Array.isArray(await invariants())).toBe(true);
  });

  it("cannot be called by the anon role", async () => {
    expect(codeOf(await anonClient().rpc("check_stock_invariants", {}))).toBe(SQLSTATE.denied);
    expect(unknownId()).toBeTruthy();
  });
});

describe("sweepReservations service", () => {
  it("runs the sweep, audits each change without secrets, and reports counts by kind", async () => {
    const expired = await held();
    const orphan = await held();
    must(await db.from("quote_versions").update({ status: "SUPERSEDED" }).eq("id", orphan.chain.quoteId));
    const stale = await inState("PAYMENT_IN_FLIGHT");

    const summary = await sweepReservations(db, { now: addMinutes(T0, 31), correlationId: "corr-sweep-test" });
    expect(summary.expiredReleased).toBeGreaterThanOrEqual(1);
    expect(summary.orphansReleased).toBeGreaterThanOrEqual(1);
    expect(summary.staleFlagged).toBeGreaterThanOrEqual(1);
    expect(summary.changes.map((c) => c.reservationId)).toEqual(expect.arrayContaining([expired.id, orphan.id, stale.id]));

    const events = must(await db.from("audit_events").select("action, actor, entity, entity_id, correlation_id, data").eq("entity", "reservation").eq("entity_id", expired.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "reservation.released", actor: "system:cron", correlation_id: "corr-sweep-test" });
    expect(events[0]!.data).toMatchObject({ reservation_id: expired.id, from: "HELD", to: "RELEASED", reason: "EXPIRED" });
  });

  it("writes nothing when nothing changed", async () => {
    await sweepReservations(db, { now: addMinutes(T0, 1000), correlationId: "corr-a" });
    const before = must(await db.from("audit_events").select("id").eq("correlation_id", "corr-b")).length;
    const summary = await sweepReservations(db, { now: addMinutes(T0, 1001), correlationId: "corr-b" });
    expect(summary.changes).toEqual([]);
    expect(before).toBe(0);
    expect(must(await db.from("audit_events").select("id").eq("correlation_id", "corr-b"))).toHaveLength(0);
  });
});
