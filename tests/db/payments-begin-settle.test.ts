// Real local Postgres. Evidence label for this file: local database, not mocked.
import { describe, expect, it } from "vitest";
import { PAIRED_RESERVATION_STATES, type AttemptState } from "@/domain/payments";
import { anonClient, codeOf, must, serviceClient, SQLSTATE, unique } from "./helpers";
import { T0, createAttempt, markApproved, pay, recordOrder, attemptRow } from "./payments-helpers";
import { addMinutes, call, discrepancies, expectStockConsistentAtEnd, releaseHold, reservationOf, reserve, stockOf, stockedChain } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

const begin = (attemptId: string, operation: string, now = T0) => pay(db, "payment_begin", { p_attempt_id: attemptId, p_operation: operation, p_now: now });
const settle = (attemptId: string, outcome: string, extra: Record<string, unknown> = {}, now = T0) =>
  pay(db, "payment_settle", { p_attempt_id: attemptId, p_outcome: outcome, p_now: now, ...extra });

type Setup = Awaited<ReturnType<typeof setup>>;

/** A purchase with a HELD reservation (4 of 10 units) and a payment attempt taken to `state`. */
async function setup(state: "APPROVED" | "AUTHORIZED" = "APPROVED") {
  const s = await stockedChain(db, { A: 10 });
  const productId = s.products.A!;
  const held = await reserve(db, s.chain.purchaseId, [{ product_id: productId, quantity: 4 }]);
  const attempt = await createAttempt(db, s.chain);
  await recordOrder(db, attempt.attempt_id!, unique("ORDER"));
  await markApproved(db, attempt.attempt_id!);
  const out = {
    ...s,
    productId,
    attemptId: attempt.attempt_id!,
    reservationId: held.reservation_id!,
    attempt: () => attemptRow(db, attempt.attempt_id!),
    reservation: () => reservationOf(db, s.chain.purchaseId),
    stock: () => stockOf(db, productId),
  };
  if (state === "AUTHORIZED") await authorize(out);
  return out;
}

async function authorize(s: { attemptId: string }, over: Record<string, unknown> = {}) {
  expect((await begin(s.attemptId, "authorize")).ok).toBe(true);
  return settle(s.attemptId, "AUTHORIZED", { p_authorization_id: unique("AUTH"), p_authorization_expires_at: addMinutes(T0, 60 * 24 * 29), ...over });
}

type Decision = "accepted" | "declined";
/** What the merchant decision RPC will do in T4, written directly so T3 can be tested on its own. */
async function decide(s: Setup, decision: Decision) {
  must(
    await db
      .from("merchant_decisions")
      .update({ decision, decided_at: T0, confirmed_conditions: [], reason: decision === "declined" ? "Cannot make it." : null })
      .eq("purchase_id", s.chain.purchaseId),
  );
}

async function decisionRow(s: Setup) {
  return (await db.from("merchant_decisions").select("decision, authorization_id, merchant_id, quote_version_id").eq("purchase_id", s.chain.purchaseId).maybeSingle()).data as
    | { decision: string; authorization_id: string; merchant_id: string; quote_version_id: string }
    | null;
}

/** After every transition the attempt and its reservation must be in step, and stock must match the reservations. */
async function expectPaired(s: Setup) {
  const attempt = await s.attempt();
  const reservation = await s.reservation();
  expect(PAIRED_RESERVATION_STATES[attempt.state as AttemptState], `attempt ${attempt.state} with reservation ${reservation?.state}`).toContain(reservation!.state);
  expect(await discrepancies(db, [s.productId])).toEqual([]);
}

describe("payment_begin", () => {
  it("authorize moves the attempt and the reservation into flight together", async () => {
    const s = await setup();
    expect(await begin(s.attemptId, "authorize")).toMatchObject({ ok: true, state: "AUTHORIZE_IN_FLIGHT", operation: "authorize" });
    expect(await s.attempt()).toMatchObject({ state: "AUTHORIZE_IN_FLIGHT" });
    expect(await s.reservation()).toMatchObject({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "authorize" });
    expect(await s.stock()).toEqual({ on_hand: 10, reserved: 4 });
    await expectPaired(s);
  });

  it.each(["CREATED", "PROVIDER_CREATED"] as const)("refuses an authorize while the attempt is only %s, changing nothing", async (state) => {
    const s = await stockedChain(db, { A: 10 });
    await reserve(db, s.chain.purchaseId, [{ product_id: s.products.A!, quantity: 4 }]);
    const a = await createAttempt(db, s.chain);
    if (state === "PROVIDER_CREATED") await recordOrder(db, a.attempt_id!, unique("ORDER"));
    expect(await begin(a.attempt_id!, "authorize")).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION", state });
    expect(await reservationOf(db, s.chain.purchaseId)).toMatchObject({ state: "HELD" });
  });

  it("rolls back when the reservation refuses: nothing is in flight and nothing may be sent", async () => {
    const released = await setup();
    await releaseHold(db, released.reservationId, "ABANDONED");
    expect(await begin(released.attemptId, "authorize")).toMatchObject({ ok: false, code: "RESERVATION_REFUSED", reservation_code: "NOT_HELD" });
    expect((await released.attempt()).state).toBe("APPROVED");
    expect((await released.reservation())!.state).toBe("RELEASED");

    const busy = await setup();
    await call(db, "begin_operation", { p_reservation_id: busy.reservationId, p_operation: "authorize", p_now: T0 });
    expect(await begin(busy.attemptId, "authorize")).toMatchObject({ ok: false, code: "RESERVATION_REFUSED", reservation_code: "OPERATION_IN_FLIGHT" });
    expect((await busy.attempt()).state).toBe("APPROVED");
  });

  it("reports a missing reservation as refused, with the attempt untouched", async () => {
    const s = await stockedChain(db, { A: 10 });
    const a = await createAttempt(db, s.chain);
    await recordOrder(db, a.attempt_id!, unique("ORDER"));
    await markApproved(db, a.attempt_id!);
    expect(await begin(a.attempt_id!, "authorize")).toMatchObject({ ok: false, code: "RESERVATION_REFUSED", reservation_code: "NOT_FOUND" });
    expect((await attemptRow(db, a.attempt_id!)).state).toBe("APPROVED");
  });

  it("an authorize on an expired hold releases the hold, expires the attempt, and nothing is sent", async () => {
    const s = await setup();
    const r = await begin(s.attemptId, "authorize", addMinutes(T0, 30));
    expect(r).toMatchObject({ ok: false, code: "RESERVATION_REFUSED", reservation_code: "HOLD_EXPIRED", attempt_state: "EXPIRED" });
    expect((await s.attempt()).state).toBe("EXPIRED");
    expect(await s.reservation()).toMatchObject({ state: "RELEASED", release_reason: "EXPIRED" });
    expect(await s.stock()).toEqual({ on_hand: 10, reserved: 0 });
    await expectPaired(s);
  });

  it("a second begin while one is in flight is refused, including the same operation", async () => {
    const s = await setup();
    await begin(s.attemptId, "authorize");
    expect(await begin(s.attemptId, "authorize")).toMatchObject({ ok: false, code: "OPERATION_IN_FLIGHT" });
    expect(await begin(s.attemptId, "capture")).toMatchObject({ ok: false, code: "OPERATION_IN_FLIGHT" });
  });

  it("five simultaneous authorizes have exactly one winner", async () => {
    const s = await setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => begin(s.attemptId, "authorize")));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.code === "OPERATION_IN_FLIGHT")).toHaveLength(4);
    await expectPaired(s);
  });

  it("refuses an unknown attempt and an unknown operation", async () => {
    const s = await setup();
    expect(await begin("00000000-0000-4000-8000-000000000000", "authorize")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await begin(s.attemptId, "refund")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await begin(s.attemptId, "create")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  describe("capture and void need the right merchant decision", () => {
    it("capture is blocked with no decision, a pending one, or a declined one", async () => {
      const s = await setup("AUTHORIZED");
      expect(await decisionRow(s)).toMatchObject({ decision: "pending" });
      expect(await begin(s.attemptId, "capture")).toMatchObject({ ok: false, code: "CAPTURE_BLOCKED" });
      await decide(s, "declined");
      expect(await begin(s.attemptId, "capture")).toMatchObject({ ok: false, code: "CAPTURE_BLOCKED" });
      expect((await s.attempt()).state).toBe("AUTHORIZED");
      expect((await s.reservation())!.state).toBe("AWAITING_CONFIRMATION");
    });

    it("capture begins once the decision is accepted, with attempt and reservation in flight together", async () => {
      const s = await setup("AUTHORIZED");
      await decide(s, "accepted");
      expect(await begin(s.attemptId, "capture")).toMatchObject({ ok: true, state: "CAPTURE_IN_FLIGHT" });
      expect(await s.reservation()).toMatchObject({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "capture" });
      await expectPaired(s);
    });

    it("void is blocked unless the decision is declined", async () => {
      const s = await setup("AUTHORIZED");
      expect(await begin(s.attemptId, "void")).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
      await decide(s, "accepted");
      expect(await begin(s.attemptId, "void")).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
      expect((await s.attempt()).state).toBe("AUTHORIZED");
    });

    it("void begins once the decision is declined", async () => {
      const s = await setup("AUTHORIZED");
      await decide(s, "declined");
      expect(await begin(s.attemptId, "void")).toMatchObject({ ok: true, state: "VOID_IN_FLIGHT" });
      expect(await s.reservation()).toMatchObject({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "void" });
      await expectPaired(s);
    });

    it("a capture and a void can never both begin: after one, the other is refused", async () => {
      const s = await setup("AUTHORIZED");
      await decide(s, "accepted");
      await begin(s.attemptId, "capture");
      expect(await begin(s.attemptId, "void")).toMatchObject({ ok: false, code: "OPERATION_IN_FLIGHT" });
      expect((await s.attempt()).state).toBe("CAPTURE_IN_FLIGHT");
    });

    it("five simultaneous captures of an accepted authorization have exactly one winner", async () => {
      const s = await setup("AUTHORIZED");
      await decide(s, "accepted");
      const results = await Promise.all(Array.from({ length: 5 }, () => begin(s.attemptId, "capture")));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => r.code === "OPERATION_IN_FLIGHT")).toHaveLength(4);
      await expectPaired(s);
    });

    it("capture is blocked once the authorization has expired", async () => {
      const s = await setup();
      await authorize(s, { p_authorization_expires_at: addMinutes(T0, 10) });
      await decide(s, "accepted");
      expect(await begin(s.attemptId, "capture", addMinutes(T0, 11))).toMatchObject({ ok: false, code: "CAPTURE_BLOCKED" });
      expect(await begin(s.attemptId, "capture", addMinutes(T0, 10))).toMatchObject({ ok: false, code: "CAPTURE_BLOCKED" });
      expect((await s.attempt()).state).toBe("AUTHORIZED");
      expect(await begin(s.attemptId, "capture", addMinutes(T0, 9))).toMatchObject({ ok: true });
    });

    it("capture is blocked when the decision is for another authorization", async () => {
      const s = await setup("AUTHORIZED");
      // A recorded decision is final, so the mismatch is built while it is still pending, then it is accepted.
      must(await db.from("merchant_decisions").update({ authorization_id: unique("OTHER") }).eq("purchase_id", s.chain.purchaseId));
      await decide(s, "accepted");
      expect(await begin(s.attemptId, "capture")).toMatchObject({ ok: false, code: "CAPTURE_BLOCKED", cause: "the decision is for another authorization" });
      expect((await s.attempt()).state).toBe("AUTHORIZED");
    });
  });

  it("an authorize is refused once the purchase has a final decision: the purchase is finished", async () => {
    const s = await setup("AUTHORIZED");
    await decide(s, "declined");
    // An unrelated second attempt (the first is ended) cannot authorize a purchase the merchant already decided.
    await begin(s.attemptId, "void");
    await settle(s.attemptId, "VOIDED");
    const second = await createAttempt(db, s.chain);
    await recordOrder(db, second.attempt_id!, unique("ORDER"));
    await markApproved(db, second.attempt_id!);
    await reserve(db, s.chain.purchaseId, [{ product_id: s.productId, quantity: 4 }], addMinutes(T0, 1));
    expect(await begin(second.attempt_id!, "authorize", addMinutes(T0, 1))).toMatchObject({ ok: false, code: "DECISION_ALREADY_MADE" });
  });
});

describe("payment_settle", () => {
  describe("AUTHORIZED", () => {
    it("records the authorization, awaits the merchant, and creates the pending decision", async () => {
      const s = await setup();
      await begin(s.attemptId, "authorize");
      const authId = unique("AUTH");
      const expires = addMinutes(T0, 60 * 24 * 29);
      expect(await settle(s.attemptId, "AUTHORIZED", { p_authorization_id: authId, p_authorization_expires_at: expires }, addMinutes(T0, 1))).toMatchObject({ ok: true, already: false, state: "AUTHORIZED" });

      const a = await s.attempt();
      expect(a).toMatchObject({ state: "AUTHORIZED", authorization_id: authId });
      expect(await s.reservation()).toMatchObject({ state: "AWAITING_CONFIRMATION", in_flight_operation: null });
      expect(await decisionRow(s)).toEqual({ decision: "pending", authorization_id: authId, merchant_id: s.chain.merchantId, quote_version_id: s.chain.quoteId });
      const times = must(await db.from("payment_attempts").select("authorized_at, authorization_expires_at").eq("id", s.attemptId).single());
      expect(new Date(times.authorized_at as string).toISOString()).toBe(addMinutes(T0, 1));
      expect(new Date(times.authorization_expires_at as string).toISOString()).toBe(expires);
      await expectPaired(s);
    });

    it("refuses a missing or malformed authorization id and leaves everything in flight", async () => {
      const s = await setup();
      await begin(s.attemptId, "authorize");
      for (const extra of [{}, { p_authorization_id: "bad id" }, { p_authorization_id: "" }]) {
        expect(await settle(s.attemptId, "AUTHORIZED", extra), JSON.stringify(extra)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      }
      expect((await s.attempt()).state).toBe("AUTHORIZE_IN_FLIGHT");
      expect((await s.reservation())!.state).toBe("PAYMENT_IN_FLIGHT");
      expect(await decisionRow(s)).toBeNull();
    });
  });

  it("AUTHORIZE_FAILED ends the attempt with a code and restarts the hold; the stock stays held", async () => {
    const s = await setup();
    await begin(s.attemptId, "authorize");
    expect(await settle(s.attemptId, "AUTHORIZE_FAILED", { p_failure_code: "INSTRUMENT_DECLINED", p_hold_minutes: 15 }, addMinutes(T0, 5))).toMatchObject({ ok: true, state: "FAILED" });
    expect(await s.attempt()).toMatchObject({ state: "FAILED", failure_code: "INSTRUMENT_DECLINED" });
    const res = await s.reservation();
    expect(res).toMatchObject({ state: "HELD" });
    expect(new Date(res!.expires_at!).toISOString()).toBe(addMinutes(T0, 20));
    expect(await s.stock()).toEqual({ on_hand: 10, reserved: 4 });
    await expectPaired(s);
  });

  it("AUTHORIZE_FAILED needs a failure code", async () => {
    const s = await setup();
    await begin(s.attemptId, "authorize");
    expect(await settle(s.attemptId, "AUTHORIZE_FAILED")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await s.attempt()).state).toBe("AUTHORIZE_IN_FLIGHT");
  });

  it("AUTHORIZE_NOT_DONE (reconciled) returns to APPROVED with the hold restarted", async () => {
    const s = await setup();
    await begin(s.attemptId, "authorize");
    expect(await settle(s.attemptId, "AUTHORIZE_NOT_DONE", { p_hold_minutes: 10 }, addMinutes(T0, 3))).toMatchObject({ ok: true, state: "APPROVED" });
    expect((await s.attempt()).state).toBe("APPROVED");
    expect(await s.reservation()).toMatchObject({ state: "HELD" });
    expect(await s.stock()).toEqual({ on_hand: 10, reserved: 4 });
    await expectPaired(s);
  });

  it("CAPTURED commits the stock and records the capture; on_hand and reserved fall together", async () => {
    const s = await setup("AUTHORIZED");
    await decide(s, "accepted");
    await begin(s.attemptId, "capture");
    const capId = unique("CAP");
    expect(await settle(s.attemptId, "CAPTURED", { p_capture_id: capId })).toMatchObject({ ok: true, state: "CAPTURED" });
    expect(await s.attempt()).toMatchObject({ state: "CAPTURED", capture_id: capId });
    expect(await s.reservation()).toMatchObject({ state: "COMMITTED" });
    expect(await s.stock()).toEqual({ on_hand: 6, reserved: 0 });
    expect(await decisionRow(s)).toMatchObject({ decision: "accepted" });
    await expectPaired(s);
  });

  it("CAPTURED needs a valid capture id: nothing is marked paid without one", async () => {
    const s = await setup("AUTHORIZED");
    await decide(s, "accepted");
    await begin(s.attemptId, "capture");
    for (const extra of [{}, { p_capture_id: "bad id" }]) expect(await settle(s.attemptId, "CAPTURED", extra), JSON.stringify(extra)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await s.attempt()).state).toBe("CAPTURE_IN_FLIGHT");
    expect(await s.stock()).toEqual({ on_hand: 10, reserved: 4 });
  });

  it.each([
    ["capture", "CAPTURE_FAILED", "accepted"],
    ["void", "VOID_FAILED", "declined"],
  ] as const)("a failed %s returns to AUTHORIZED and AWAITING_CONFIRMATION, stock still held", async (operation, outcome, decision) => {
    const s = await setup("AUTHORIZED");
    await decide(s, decision);
    await begin(s.attemptId, operation);
    expect(await settle(s.attemptId, outcome)).toMatchObject({ ok: true, state: "AUTHORIZED" });
    expect((await s.attempt()).state).toBe("AUTHORIZED");
    expect((await s.reservation())!.state).toBe("AWAITING_CONFIRMATION");
    expect(await s.stock()).toEqual({ on_hand: 10, reserved: 4 });
    await expectPaired(s);
  });

  it("VOIDED releases the stock; the reason is DECLINED unless the caller says VOIDED", async () => {
    const declined = await setup("AUTHORIZED");
    await decide(declined, "declined");
    await begin(declined.attemptId, "void");
    expect(await settle(declined.attemptId, "VOIDED")).toMatchObject({ ok: true, state: "VOIDED" });
    expect(await declined.reservation()).toMatchObject({ state: "RELEASED", release_reason: "DECLINED" });
    expect(await declined.stock()).toEqual({ on_hand: 10, reserved: 0 });
    await expectPaired(declined);

    const changed = await setup("AUTHORIZED");
    await decide(changed, "declined");
    await begin(changed.attemptId, "void");
    await settle(changed.attemptId, "VOIDED", { p_release_reason: "VOIDED" });
    expect(await changed.reservation()).toMatchObject({ state: "RELEASED", release_reason: "VOIDED" });
  });

  it("VOIDED refuses a release reason a void cannot have", async () => {
    const s = await setup("AUTHORIZED");
    await decide(s, "declined");
    await begin(s.attemptId, "void");
    expect(await settle(s.attemptId, "VOIDED", { p_release_reason: "EXPIRED" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await s.attempt()).state).toBe("VOID_IN_FLIGHT");
  });

  it.each([
    ["authorize", async (s: Setup): Promise<void> => void (await begin(s.attemptId, "authorize"))],
    [
      "capture",
      async (s: Setup): Promise<void> => {
        await authorize(s);
        await decide(s, "accepted");
        await begin(s.attemptId, "capture");
      },
    ],
    [
      "void",
      async (s: Setup): Promise<void> => {
        await authorize(s);
        await decide(s, "declined");
        await begin(s.attemptId, "void");
      },
    ],
  ] as const)("an unknown %s outcome is OUTCOME_UNKNOWN for that operation, with the reservation in review and stock held", async (operation, prepare) => {
    const s = await setup();
    await prepare(s);
    expect(await settle(s.attemptId, "UNKNOWN", { p_note: "timeout after 15s" })).toMatchObject({ ok: true, state: "OUTCOME_UNKNOWN" });
    expect(await s.attempt()).toMatchObject({ state: "OUTCOME_UNKNOWN", unknown_operation: operation });
    expect(await s.reservation()).toMatchObject({ state: "REVIEW_REQUIRED", review_reason: "timeout after 15s" });
    expect(await s.stock()).toEqual({ on_hand: 10, reserved: 4 });
    // An uncertain outcome blocks any new attempt until PayPal has been asked.
    expect(await createAttempt(db, s.chain)).toMatchObject({ ok: false, code: "ATTEMPT_ACTIVE", state: "OUTCOME_UNKNOWN" });
    await expectPaired(s);
  });

  describe("EXCEPTION (a financial mismatch)", () => {
    it("is final, never paid, with a reason; the reservation goes to review and the stock stays held", async () => {
      const s = await setup();
      await begin(s.attemptId, "authorize");
      const authId = unique("AUTH");
      expect(await settle(s.attemptId, "EXCEPTION", { p_exception_reason: "AMOUNT_MISMATCH", p_authorization_id: authId })).toMatchObject({ ok: true, state: "EXCEPTION" });
      expect(await s.attempt()).toMatchObject({ state: "EXCEPTION", exception_reason: "AMOUNT_MISMATCH", authorization_id: authId, capture_id: null });
      expect(await s.reservation()).toMatchObject({ state: "REVIEW_REQUIRED" });
      expect((await s.reservation())!.review_reason).toMatch(/AMOUNT_MISMATCH/);
      expect(await s.stock()).toEqual({ on_hand: 10, reserved: 4 });
      expect(await decisionRow(s)).toBeNull(); // no decision to make on a payment that is not valid
      await expectPaired(s);
    });

    it("a capture that does not match is an exception too, with the stock held and nothing committed", async () => {
      const s = await setup("AUTHORIZED");
      await decide(s, "accepted");
      await begin(s.attemptId, "capture");
      expect(await settle(s.attemptId, "EXCEPTION", { p_exception_reason: "AMOUNT_MISMATCH", p_capture_id: unique("CAP") })).toMatchObject({ ok: true, state: "EXCEPTION" });
      expect(await s.stock()).toEqual({ on_hand: 10, reserved: 4 });
      expect((await s.reservation())!.state).toBe("REVIEW_REQUIRED");
    });

    it("refuses an unknown reason", async () => {
      const s = await setup();
      await begin(s.attemptId, "authorize");
      for (const extra of [{}, { p_exception_reason: "BORED" }]) expect(await settle(s.attemptId, "EXCEPTION", extra), JSON.stringify(extra)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect((await s.attempt()).state).toBe("AUTHORIZE_IN_FLIGHT");
    });
  });

  describe("repeating and racing", () => {
    it.each([
      ["AUTHORIZED", async (s: Setup): Promise<void> => { await begin(s.attemptId, "authorize"); }, { p_authorization_id: "AUTH-REPEAT" }],
      ["CAPTURED", async (s: Setup): Promise<void> => { await authorize(s); await decide(s, "accepted"); await begin(s.attemptId, "capture"); }, { p_capture_id: "CAP-REPEAT" }],
      ["VOIDED", async (s: Setup): Promise<void> => { await authorize(s); await decide(s, "declined"); await begin(s.attemptId, "void"); }, {}],
      ["UNKNOWN", async (s: Setup): Promise<void> => { await begin(s.attemptId, "authorize"); }, {}],
      ["EXCEPTION", async (s: Setup): Promise<void> => { await begin(s.attemptId, "authorize"); }, { p_exception_reason: "ORDER_MISMATCH" }],
    ] as const)("repeating %s returns the same result and changes nothing twice", async (outcome, prepare, extra) => {
      const s = await setup();
      await prepare(s);
      const first = await settle(s.attemptId, outcome, extra);
      const stockAfterFirst = await s.stock();
      const again = await settle(s.attemptId, outcome, extra);
      expect(first).toMatchObject({ ok: true, already: false });
      expect(again).toMatchObject({ ok: true, already: true });
      expect(await s.stock()).toEqual(stockAfterFirst);
      await expectPaired(s);
    });

    it("repeating a failure outcome is refused, not mistaken for success", async () => {
      const s = await setup("AUTHORIZED");
      await decide(s, "accepted");
      await begin(s.attemptId, "capture");
      await settle(s.attemptId, "CAPTURE_FAILED");
      expect(await settle(s.attemptId, "CAPTURE_FAILED")).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    });

    it("five simultaneous CAPTURED settlements commit the stock once", async () => {
      const s = await setup("AUTHORIZED");
      await decide(s, "accepted");
      await begin(s.attemptId, "capture");
      const results = await Promise.all(Array.from({ length: 5 }, () => settle(s.attemptId, "CAPTURED", { p_capture_id: "CAP-RACE" })));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => r.already === false)).toHaveLength(1);
      expect(await s.stock()).toEqual({ on_hand: 6, reserved: 0 });
      await expectPaired(s);
    });

    it("an outcome that does not fit the operation in flight is refused and changes nothing", async () => {
      const s = await setup();
      await begin(s.attemptId, "authorize");
      for (const outcome of ["CAPTURED", "CAPTURE_FAILED", "VOIDED", "VOID_FAILED"]) {
        expect(await settle(s.attemptId, outcome, { p_capture_id: "CAP-X" }), outcome).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
      }
      expect((await s.attempt()).state).toBe("AUTHORIZE_IN_FLIGHT");

      const c = await setup("AUTHORIZED");
      await decide(c, "accepted");
      await begin(c.attemptId, "capture");
      for (const outcome of ["AUTHORIZED", "AUTHORIZE_FAILED", "VOIDED", "VOID_FAILED"]) {
        expect(await settle(c.attemptId, outcome, { p_authorization_id: "AUTH-X", p_failure_code: "X" }), outcome).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
      }
      expect((await c.attempt()).state).toBe("CAPTURE_IN_FLIGHT");
      expect(await c.stock()).toEqual({ on_hand: 10, reserved: 4 });
    });

    it("refuses to settle when nothing is in flight, and an unknown attempt or outcome", async () => {
      const s = await setup();
      expect(await settle(s.attemptId, "AUTHORIZED", { p_authorization_id: "AUTH-X" })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
      expect(await settle("00000000-0000-4000-8000-000000000000", "UNKNOWN")).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(await settle(s.attemptId, "PAID")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    });
  });

  describe("when the sweep has already sent the reservation to review", () => {
    async function flagged(prepare: (s: Setup) => Promise<void>) {
      const s = await setup();
      await prepare(s);
      must(await db.rpc("flag_for_review", { p_reservation_id: s.reservationId, p_reason: "stuck in flight", p_now: T0 }));
      expect((await s.reservation())!.state).toBe("REVIEW_REQUIRED");
      return s;
    }

    it("a capture that settles afterwards still commits the stock, once", async () => {
      const s = await flagged(async (x) => {
        await authorize(x);
        await decide(x, "accepted");
        await begin(x.attemptId, "capture");
      });
      expect(await settle(s.attemptId, "CAPTURED", { p_capture_id: "CAP-LATE" })).toMatchObject({ ok: true, state: "CAPTURED" });
      expect((await s.reservation())!.state).toBe("COMMITTED");
      expect(await s.stock()).toEqual({ on_hand: 6, reserved: 0 });
      await expectPaired(s);
    });

    it("an authorization that settles afterwards moves the reservation to awaiting confirmation", async () => {
      const s = await flagged(async (x): Promise<void> => void (await begin(x.attemptId, "authorize")));
      expect(await settle(s.attemptId, "AUTHORIZED", { p_authorization_id: "AUTH-LATE" })).toMatchObject({ ok: true, state: "AUTHORIZED" });
      expect((await s.reservation())!.state).toBe("AWAITING_CONFIRMATION");
      await expectPaired(s);
    });

    it("a void that settles afterwards releases the stock", async () => {
      const s = await flagged(async (x) => {
        await authorize(x);
        await decide(x, "declined");
        await begin(x.attemptId, "void");
      });
      expect(await settle(s.attemptId, "VOIDED")).toMatchObject({ ok: true, state: "VOIDED" });
      expect(await s.reservation()).toMatchObject({ state: "RELEASED", release_reason: "DECLINED" });
      expect(await s.stock()).toEqual({ on_hand: 10, reserved: 0 });
    });

    it("an unknown outcome leaves the reservation in review", async () => {
      const s = await flagged(async (x): Promise<void> => void (await begin(x.attemptId, "authorize")));
      expect(await settle(s.attemptId, "UNKNOWN")).toMatchObject({ ok: true, state: "OUTCOME_UNKNOWN" });
      expect((await s.reservation())!.state).toBe("REVIEW_REQUIRED");
      await expectPaired(s);
    });
  });
});

describe("function privileges", () => {
  it.each([
    ["payment_begin", { p_attempt_id: "00000000-0000-4000-8000-000000000000", p_operation: "authorize", p_now: T0 }],
    ["payment_settle", { p_attempt_id: "00000000-0000-4000-8000-000000000000", p_outcome: "UNKNOWN", p_now: T0 }],
  ])("%s cannot be called by the anon role", async (fn, args) => {
    expect(codeOf(await anonClient().rpc(fn, args))).toBe(SQLSTATE.denied);
  });

  it("the internal reservation helper cannot be called through the API at all", async () => {
    const r = await db.rpc("payment_settle_reservation", { p_reservation_id: "00000000-0000-4000-8000-000000000000", p_outcome: "UNKNOWN", p_now: T0, p_hold_minutes: 30, p_release_reason: "VOIDED", p_note: null });
    expect(codeOf(r)).toBe(SQLSTATE.denied);
  });
});
