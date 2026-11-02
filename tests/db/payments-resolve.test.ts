// Real local Postgres. Evidence label for this file: local database, not mocked.
import { describe, expect, it } from "vitest";
import { PAIRED_RESERVATION_STATES, type AttemptState } from "@/domain/payments";
import { anonClient, codeOf, serviceClient, SQLSTATE, unique } from "./helpers";
import { begin, decide, decisionOf, payFixture, settle, unknownFixture, type Fixture } from "./payments-fixtures";
import { T0, createAttempt, markApproved, pay, recordOrder } from "./payments-helpers";
import { addMinutes, discrepancies, reservationOf, reserve } from "./reservation-helpers";

const db = serviceClient();

const resolve = (attemptId: string, resolution: string, extra: Record<string, unknown> = {}, now = T0) =>
  pay(db, "payment_resolve_unknown", { p_attempt_id: attemptId, p_resolution: resolution, p_now: now, ...extra });
const expire = (attemptId: string, evidence = "PayPal shows the authorization expired", now = T0) =>
  pay(db, "payment_expire", { p_attempt_id: attemptId, p_evidence: evidence, p_now: now });

async function expectPaired(f: Fixture) {
  const attempt = await f.attempt();
  const reservation = await f.reservation();
  expect(PAIRED_RESERVATION_STATES[attempt.state as AttemptState], `attempt ${attempt.state} with reservation ${reservation?.state}`).toContain(reservation!.state);
  expect(await discrepancies(db, [f.productId])).toEqual([]);
}

describe("payment_resolve_unknown: an uncertain authorize", () => {
  it("PayPal shows it authorized: AUTHORIZED, the merchant decision is created, the reservation awaits", async () => {
    const f = await unknownFixture(db, "authorize");
    expect((await f.attempt()).unknown_operation).toBe("authorize");
    const authId = unique("AUTH");
    expect(await resolve(f.attemptId, "AUTHORIZED", { p_authorization_id: authId, p_authorization_expires_at: addMinutes(T0, 60) })).toMatchObject({ ok: true, already: false, state: "AUTHORIZED" });
    expect(await f.attempt()).toMatchObject({ state: "AUTHORIZED", authorization_id: authId, unknown_operation: null });
    expect(await f.reservation()).toMatchObject({ state: "AWAITING_CONFIRMATION" });
    expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: "pending", authorization_id: authId });
    await expectPaired(f);
  });

  it("PayPal shows it never happened: back to APPROVED with the hold restarted", async () => {
    const f = await unknownFixture(db, "authorize");
    const now = addMinutes(T0, 5);
    expect(await resolve(f.attemptId, "APPROVED", { p_hold_minutes: 12 }, now)).toMatchObject({ ok: true, state: "APPROVED" });
    expect(await f.attempt()).toMatchObject({ state: "APPROVED", unknown_operation: null });
    const res = await f.reservation();
    expect(res).toMatchObject({ state: "HELD" });
    expect(new Date(res!.expires_at!).toISOString()).toBe(addMinutes(now, 12));
    expect(await f.stock()).toEqual({ on_hand: 10, reserved: 4 });
    await expectPaired(f);
  });

  it("PayPal refused it: FAILED with a code, and a new attempt is now allowed", async () => {
    const f = await unknownFixture(db, "authorize");
    expect(await resolve(f.attemptId, "FAILED", { p_failure_code: "INSTRUMENT_DECLINED" })).toMatchObject({ ok: true, state: "FAILED" });
    expect(await f.attempt()).toMatchObject({ state: "FAILED", failure_code: "INSTRUMENT_DECLINED" });
    expect(await f.reservation()).toMatchObject({ state: "HELD" });
    const again = await createAttempt(db, { merchantId: f.merchantId, inquiryId: f.inquiryId, quoteId: f.quoteId, quoteHash: f.quoteHash, approvalId: "", purchaseId: f.purchaseId });
    expect(again).toMatchObject({ ok: true, already: false, state: "CREATED" });
  });

  it("PayPal shows a payment that does not match: EXCEPTION, never paid, the reservation stays in review", async () => {
    const f = await unknownFixture(db, "authorize");
    expect(await resolve(f.attemptId, "EXCEPTION", { p_exception_reason: "AMOUNT_MISMATCH", p_authorization_id: unique("AUTH") })).toMatchObject({ ok: true, state: "EXCEPTION" });
    expect(await f.attempt()).toMatchObject({ state: "EXCEPTION", exception_reason: "AMOUNT_MISMATCH", capture_id: null });
    expect((await f.reservation())!.state).toBe("REVIEW_REQUIRED");
    expect(await f.stock()).toEqual({ on_hand: 10, reserved: 4 });
    await expectPaired(f);
  });

  it("refuses resolutions that do not fit an uncertain authorize", async () => {
    const f = await unknownFixture(db, "authorize");
    for (const resolution of ["CAPTURED", "VOIDED", "EXPIRED", "CAPTURE_IN_FLIGHT"]) {
      expect(await resolve(f.attemptId, resolution, { p_capture_id: "CAP-X" }), resolution).toMatchObject({ ok: false });
    }
    expect((await f.attempt()).state).toBe("OUTCOME_UNKNOWN");
  });
});

describe("payment_resolve_unknown: an uncertain capture", () => {
  it("PayPal shows a completed capture: CAPTURED, the stock is committed once", async () => {
    const f = await unknownFixture(db, "capture");
    expect((await f.attempt()).unknown_operation).toBe("capture");
    const cap = unique("CAP");
    expect(await resolve(f.attemptId, "CAPTURED", { p_capture_id: cap })).toMatchObject({ ok: true, state: "CAPTURED" });
    expect(await f.attempt()).toMatchObject({ state: "CAPTURED", capture_id: cap, unknown_operation: null });
    expect(await f.reservation()).toMatchObject({ state: "COMMITTED" });
    expect(await f.stock()).toEqual({ on_hand: 6, reserved: 0 });
    await expectPaired(f);
  });

  it("PayPal shows nothing was captured: back to AUTHORIZED, awaiting the merchant again, a retry is allowed", async () => {
    const f = await unknownFixture(db, "capture");
    expect(await resolve(f.attemptId, "AUTHORIZED")).toMatchObject({ ok: true, state: "AUTHORIZED" });
    expect((await f.attempt()).state).toBe("AUTHORIZED");
    expect((await f.reservation())!.state).toBe("AWAITING_CONFIRMATION");
    expect(await f.stock()).toEqual({ on_hand: 10, reserved: 4 });
    // The decision is still accepted, so the capture may be begun again (and sent with the same request id).
    expect(await begin(db, f.attemptId, "capture")).toMatchObject({ ok: true, state: "CAPTURE_IN_FLIGHT" });
    await expectPaired(f);
  });

  it("PayPal shows a capture that does not match: EXCEPTION, the stock stays held, nothing is committed", async () => {
    const f = await unknownFixture(db, "capture");
    expect(await resolve(f.attemptId, "EXCEPTION", { p_exception_reason: "AMOUNT_MISMATCH", p_capture_id: unique("CAP") })).toMatchObject({ ok: true, state: "EXCEPTION" });
    expect(await f.stock()).toEqual({ on_hand: 10, reserved: 4 });
    expect((await f.reservation())!.state).toBe("REVIEW_REQUIRED");
  });

  it("refuses a capture resolution without a capture id: nothing is paid without one", async () => {
    const f = await unknownFixture(db, "capture");
    expect(await resolve(f.attemptId, "CAPTURED")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await f.attempt()).state).toBe("OUTCOME_UNKNOWN");
  });
});

describe("payment_resolve_unknown: an uncertain void", () => {
  it("PayPal shows the authorization voided: VOIDED, the stock is released", async () => {
    const f = await unknownFixture(db, "void");
    expect((await f.attempt()).unknown_operation).toBe("void");
    expect(await resolve(f.attemptId, "VOIDED")).toMatchObject({ ok: true, state: "VOIDED" });
    expect(await f.attempt()).toMatchObject({ state: "VOIDED", unknown_operation: null });
    expect(await f.reservation()).toMatchObject({ state: "RELEASED", release_reason: "DECLINED" });
    expect(await f.stock()).toEqual({ on_hand: 10, reserved: 0 });
    await expectPaired(f);
  });

  it("PayPal shows the authorization still there: back to AUTHORIZED, stock held, the decline can be retried", async () => {
    const f = await unknownFixture(db, "void");
    expect(await resolve(f.attemptId, "AUTHORIZED")).toMatchObject({ ok: true, state: "AUTHORIZED" });
    expect(await f.stock()).toEqual({ on_hand: 10, reserved: 4 });
    expect(await begin(db, f.attemptId, "void")).toMatchObject({ ok: true, state: "VOID_IN_FLIGHT" });
  });

  it("PayPal shows the authorization was captured after all: EXCEPTION (a decline that was captured)", async () => {
    const f = await unknownFixture(db, "void");
    expect(await resolve(f.attemptId, "EXCEPTION", { p_exception_reason: "STATUS_NOT_AS_EXPECTED" })).toMatchObject({ ok: true, state: "EXCEPTION" });
    expect((await f.reservation())!.state).toBe("REVIEW_REQUIRED");
    expect(await f.stock()).toEqual({ on_hand: 10, reserved: 4 });
  });

  it("a void resolution can name why the stock is released", async () => {
    const f = await unknownFixture(db, "void");
    await resolve(f.attemptId, "VOIDED", { p_release_reason: "VOIDED" });
    expect(await f.reservation()).toMatchObject({ state: "RELEASED", release_reason: "VOIDED" });
  });
});

describe("payment_resolve_unknown: the only way out", () => {
  it("an attempt that is not uncertain is refused", async () => {
    const f = await payFixture(db);
    expect(await resolve(f.attemptId, "FAILED", { p_failure_code: "X" })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect((await f.attempt()).state).toBe("AUTHORIZED");
    const inFlight = await payFixture(db, "APPROVED");
    await begin(db, inFlight.attemptId, "authorize");
    expect(await resolve(inFlight.attemptId, "AUTHORIZED", { p_authorization_id: "AUTH-X" })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect((await inFlight.attempt()).state).toBe("AUTHORIZE_IN_FLIGHT");
  });

  it("an in-flight attempt cannot be settled as an uncertain one by payment_settle (UNKNOWN is the only exit from flight to doubt)", async () => {
    const f = await unknownFixture(db, "capture");
    expect(await settle(db, f.attemptId, "CAPTURED", { p_capture_id: "CAP-GUESS" })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect((await f.attempt()).state).toBe("OUTCOME_UNKNOWN");
    expect(await f.stock()).toEqual({ on_hand: 10, reserved: 4 });
  });

  it("repeating a resolution returns the same result and changes nothing twice", async () => {
    const f = await unknownFixture(db, "capture");
    const cap = unique("CAP");
    const first = await resolve(f.attemptId, "CAPTURED", { p_capture_id: cap });
    const again = await resolve(f.attemptId, "CAPTURED", { p_capture_id: cap });
    expect(first).toMatchObject({ ok: true, already: false });
    expect(again).toMatchObject({ ok: true, already: true, state: "CAPTURED" });
    expect(await f.stock()).toEqual({ on_hand: 6, reserved: 0 });
  });

  it("five simultaneous resolutions commit the stock once", async () => {
    const f = await unknownFixture(db, "capture");
    const cap = unique("CAP");
    const results = await Promise.all(Array.from({ length: 5 }, () => resolve(f.attemptId, "CAPTURED", { p_capture_id: cap })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.already === false)).toHaveLength(1);
    expect(await f.stock()).toEqual({ on_hand: 6, reserved: 0 });
    await expectPaired(f);
  });

  it("a capture resolution racing a not-captured resolution has one winner and stock changes at most once", async () => {
    for (let i = 0; i < 6; i++) {
      const f = await unknownFixture(db, "capture");
      const [a, b] = await Promise.all([resolve(f.attemptId, "CAPTURED", { p_capture_id: unique(`CAP${i}`) }), resolve(f.attemptId, "AUTHORIZED")]);
      expect(Number(a.ok) + Number(b.ok), `round ${i}`).toBe(1);
      const stock = await f.stock();
      expect(stock).toEqual(a.ok ? { on_hand: 6, reserved: 0 } : { on_hand: 10, reserved: 4 });
      await expectPaired(f);
    }
  });

  it("refuses a missing id, a bad failure code, an unknown resolution, and an unknown attempt", async () => {
    const f = await unknownFixture(db, "authorize");
    expect(await resolve(f.attemptId, "AUTHORIZED")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await resolve(f.attemptId, "FAILED")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await resolve(f.attemptId, "EXCEPTION")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await resolve(f.attemptId, "SETTLED")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await resolve("00000000-0000-4000-8000-000000000000", "FAILED", { p_failure_code: "X" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect((await f.attempt()).state).toBe("OUTCOME_UNKNOWN");
  });
});

describe("payment_expire", () => {
  it.each(["CREATED", "PROVIDER_CREATED", "APPROVED"] as const)("a %s attempt expires once the hold has run out, and the reservation is left to the sweep", async (from) => {
    const f = await payFixture(db, from);
    expect((await f.attempt()).state).toBe(from);
    // The hold (30 minutes from T0) has not run out yet.
    expect(await expire(f.attemptId, "idle", addMinutes(T0, 29))).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(await expire(f.attemptId, "idle past the hold", addMinutes(T0, 30))).toMatchObject({ ok: true, already: false, state: "EXPIRED" });
    expect((await f.attempt()).state).toBe("EXPIRED");
    expect((await f.reservation())!.state).toBe("HELD"); // the reservation sweep releases it, on its own clock
  });

  it("an attempt whose reservation was already released expires at once", async () => {
    const f = await payFixture(db, "APPROVED");
    await db.rpc("release_hold", { p_reservation_id: f.reservationId, p_reason: "ABANDONED", p_now: T0 });
    expect(await expire(f.attemptId, "hold released", T0)).toMatchObject({ ok: true, state: "EXPIRED" });
  });

  it("an authorization past its expiry expires the attempt and releases the stock with the evidence on file", async () => {
    const f = await payFixture(db);
    await db.from("payment_attempts").update({ authorization_expires_at: addMinutes(T0, 100) }).eq("id", f.attemptId);
    expect(await expire(f.attemptId, "PayPal shows EXPIRED", addMinutes(T0, 99))).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect((await f.attempt()).state).toBe("AUTHORIZED");

    expect(await expire(f.attemptId, "PayPal shows the authorization EXPIRED", addMinutes(T0, 100))).toMatchObject({ ok: true, already: false, state: "EXPIRED" });
    expect((await f.attempt()).state).toBe("EXPIRED");
    const res = await f.reservation();
    expect(res).toMatchObject({ state: "RELEASED", release_reason: "EXPIRED", review_reason: "PayPal shows the authorization EXPIRED" });
    expect(await f.stock()).toEqual({ on_hand: 10, reserved: 0 });
    expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: "pending" });
    await expectPaired(f);
  });

  it("after an expired authorization the customer can start again: re-hold, a new attempt, a new authorization on the same pending decision", async () => {
    const f = await payFixture(db);
    await db.from("payment_attempts").update({ authorization_expires_at: addMinutes(T0, 100) }).eq("id", f.attemptId);
    await expire(f.attemptId, "expired", addMinutes(T0, 100));

    const later = addMinutes(T0, 120);
    expect(await reserve(db, f.purchaseId, [{ product_id: f.productId, quantity: 4 }], later)).toMatchObject({ ok: true, reheld: true });
    const second = await createAttempt(db, { merchantId: f.merchantId, inquiryId: f.inquiryId, quoteId: f.quoteId, quoteHash: f.quoteHash, approvalId: "", purchaseId: f.purchaseId }, { p_now: later });
    expect(second).toMatchObject({ ok: true, already: false });
    await recordOrder(db, second.attempt_id!, unique("ORDER"));
    await markApproved(db, second.attempt_id!);
    expect(await begin(db, second.attempt_id!, "authorize", later)).toMatchObject({ ok: true });
    const newAuth = unique("AUTH");
    expect(await settle(db, second.attempt_id!, "AUTHORIZED", { p_authorization_id: newAuth }, later)).toMatchObject({ ok: true, state: "AUTHORIZED" });
    expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: "pending", authorization_id: newAuth });
    expect(await reservationOf(db, f.purchaseId)).toMatchObject({ state: "AWAITING_CONFIRMATION" });
  });

  it("is a no-op for an attempt already EXPIRED, and refuses other states and a blank evidence", async () => {
    const f = await payFixture(db);
    await db.from("payment_attempts").update({ authorization_expires_at: addMinutes(T0, 5) }).eq("id", f.attemptId);
    await expire(f.attemptId, "expired", addMinutes(T0, 5));
    expect(await expire(f.attemptId, "expired", addMinutes(T0, 6))).toMatchObject({ ok: true, already: true, state: "EXPIRED" });

    const inFlight = await payFixture(db);
    await decide(db, inFlight, "accepted");
    expect(await expire(inFlight.attemptId, "x", addMinutes(T0, 100000))).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });

    const blank = await payFixture(db);
    expect(await expire(blank.attemptId, "   ")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await expire("00000000-0000-4000-8000-000000000000", "x")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("an authorization without an expiry on file is never expired by the clock", async () => {
    const f = await payFixture(db);
    await db.from("payment_attempts").update({ authorization_expires_at: null }).eq("id", f.attemptId);
    expect(await expire(f.attemptId, "x", addMinutes(T0, 100000))).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });
});

describe("function privileges", () => {
  it.each([
    ["payment_resolve_unknown", { p_attempt_id: "00000000-0000-4000-8000-000000000000", p_resolution: "FAILED", p_now: T0 }],
    ["payment_expire", { p_attempt_id: "00000000-0000-4000-8000-000000000000", p_evidence: "x", p_now: T0 }],
  ])("%s cannot be called by the anon role", async (fn, args) => {
    expect(codeOf(await anonClient().rpc(fn, args))).toBe(SQLSTATE.denied);
  });

  it("the internal outcome helper cannot be called through the API at all", async () => {
    const r = await db.rpc("payment_apply_outcome", { p_attempt_id: "00000000-0000-4000-8000-000000000000", p_outcome: "UNKNOWN", p_op: "authorize", p_now: T0 });
    expect(codeOf(r)).toBe(SQLSTATE.denied);
  });
});
