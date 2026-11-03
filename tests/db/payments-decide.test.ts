// Real local Postgres. Evidence label for this file: local database, not mocked.
import { describe, expect, it } from "vitest";
import { PAIRED_RESERVATION_STATES, unconfirmedConditions, type AttemptState } from "@/domain/payments";
import type { Condition as QuoteCondition } from "@/domain/quote";
import { anonClient, codeOf, serviceClient, SQLSTATE } from "./helpers";
import { decide, decisionOf, payFixture, unknownFixture, type Fixture } from "./payments-fixtures";
import { T0 } from "./payments-helpers";
import { addMinutes, discrepancies } from "./reservation-helpers";

const db = serviceClient();

const SLOT = { code: "PRODUCTION_SLOT_CONFIRMATION", text: "Production slot to be confirmed." };
const ART = { code: "ARTWORK_ACCEPTANCE", text: "Artwork to be accepted." };
const APPROVED_CUSTOM = { code: "MERCHANT_APPROVED_CUSTOMIZATION", text: "Foil lid approved." };

async function expectPaired(f: Fixture) {
  const attempt = await f.attempt();
  const reservation = await f.reservation();
  expect(PAIRED_RESERVATION_STATES[attempt.state as AttemptState], `attempt ${attempt.state} with reservation ${reservation?.state}`).toContain(reservation!.state);
  expect(await discrepancies(db, [f.productId])).toEqual([]);
}

describe("payment_decide: accept", () => {
  it("records the acceptance and begins the capture in the same transaction", async () => {
    const f = await payFixture(db);
    const r = await decide(db, f, "accepted", { now: addMinutes(T0, 2) });
    expect(r).toMatchObject({ ok: true, already: false, decision: "accepted", state: "CAPTURE_IN_FLIGHT", operation: "capture", authorization_id: f.authorizationId });

    const d = await decisionOf(db, f.purchaseId);
    expect(d).toMatchObject({ decision: "accepted", reason: null, confirmed_conditions: [] });
    expect(new Date(d!.decided_at!).toISOString()).toBe(addMinutes(T0, 2));
    expect((await f.attempt()).state).toBe("CAPTURE_IN_FLIGHT");
    expect(await f.reservation()).toMatchObject({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "capture" });
    expect(await f.stock()).toEqual({ on_hand: 10, reserved: 4 });
    await expectPaired(f);
  });

  it("stores which conditions the merchant confirmed", async () => {
    const f = await payFixture(db, "AUTHORIZED", [SLOT, ART]);
    expect(await decide(db, f, "accepted", { confirmed: ["PRODUCTION_SLOT_CONFIRMATION", "ARTWORK_ACCEPTANCE"] })).toMatchObject({ ok: true });
    expect((await decisionOf(db, f.purchaseId))!.confirmed_conditions).toEqual(["PRODUCTION_SLOT_CONFIRMATION", "ARTWORK_ACCEPTANCE"]);
  });
});

describe("payment_decide: decline", () => {
  it("records the decline with its reason and begins the void in the same transaction", async () => {
    const f = await payFixture(db);
    const r = await decide(db, f, "declined", { reason: "We cannot make this by the date." });
    expect(r).toMatchObject({ ok: true, already: false, decision: "declined", state: "VOID_IN_FLIGHT", operation: "void" });
    expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: "declined", reason: "We cannot make this by the date." });
    expect((await f.attempt()).state).toBe("VOID_IN_FLIGHT");
    expect(await f.reservation()).toMatchObject({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "void" });
    await expectPaired(f);
  });

  it("needs a reason, and starts nothing without one", async () => {
    const f = await payFixture(db);
    for (const reason of [null, "", "   "]) {
      expect(await decide(db, f, "declined", { reason }), String(reason)).toMatchObject({ ok: false, code: "REASON_REQUIRED" });
    }
    expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: "pending" });
    expect((await f.attempt()).state).toBe("AUTHORIZED");
    expect((await f.reservation())!.state).toBe("AWAITING_CONFIRMATION");
  });

  it("needs no confirmation of conditions", async () => {
    const f = await payFixture(db, "AUTHORIZED", [SLOT, ART]);
    expect(await decide(db, f, "declined", { reason: "No." })).toMatchObject({ ok: true });
  });

  it("refuses a reason longer than 500 characters", async () => {
    const f = await payFixture(db);
    expect(await decide(db, f, "declined", { reason: "x".repeat(501) })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: "pending" });
  });
});

describe("payment_decide: conditions the merchant must confirm", () => {
  it("accepting needs every pending condition confirmed, and says which are missing", async () => {
    const f = await payFixture(db, "AUTHORIZED", [SLOT, ART]);
    expect(await decide(db, f, "accepted", { confirmed: [] })).toMatchObject({ ok: false, code: "CONDITIONS_UNCONFIRMED", missing: ["PRODUCTION_SLOT_CONFIRMATION", "ARTWORK_ACCEPTANCE"] });
    expect(await decide(db, f, "accepted", { confirmed: ["ARTWORK_ACCEPTANCE"] })).toMatchObject({ ok: false, code: "CONDITIONS_UNCONFIRMED", missing: ["PRODUCTION_SLOT_CONFIRMATION"] });
    expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: "pending" });
    expect((await f.attempt()).state).toBe("AUTHORIZED");
    expect(await decide(db, f, "accepted", { confirmed: ["PRODUCTION_SLOT_CONFIRMATION", "ARTWORK_ACCEPTANCE"] })).toMatchObject({ ok: true });
  });

  it("a condition the merchant already approved in their own words needs no further confirmation", async () => {
    const f = await payFixture(db, "AUTHORIZED", [APPROVED_CUSTOM]);
    expect(await decide(db, f, "accepted")).toMatchObject({ ok: true });
  });

  it("agrees with the pure function over every combination", async () => {
    const quoteConditions: QuoteCondition[][] = [[], [SLOT as QuoteCondition], [ART as QuoteCondition], [SLOT, ART, APPROVED_CUSTOM] as QuoteCondition[]];
    const confirmations = [[], ["PRODUCTION_SLOT_CONFIRMATION"], ["ARTWORK_ACCEPTANCE"], ["PRODUCTION_SLOT_CONFIRMATION", "ARTWORK_ACCEPTANCE"], ["SOMETHING_ELSE"]];
    for (const conditions of quoteConditions) {
      for (const confirmed of confirmations) {
        const f = await payFixture(db, "AUTHORIZED", conditions);
        const expectedMissing = unconfirmedConditions(conditions, confirmed);
        const r = await decide(db, f, "accepted", { confirmed });
        if (expectedMissing.length === 0) expect(r, JSON.stringify({ conditions, confirmed })).toMatchObject({ ok: true });
        else expect(r, JSON.stringify({ conditions, confirmed })).toMatchObject({ ok: false, code: "CONDITIONS_UNCONFIRMED", missing: expectedMissing });
      }
    }
  });

  it("refuses a confirmation list that is not a list of short strings", async () => {
    const f = await payFixture(db);
    for (const confirmed of ["PRODUCTION_SLOT_CONFIRMATION", { a: 1 }, [1, 2], ["x".repeat(65)], Array.from({ length: 11 }, (_, i) => `C${i}`)]) {
      expect(await decide(db, f, "accepted", { confirmed }), JSON.stringify(confirmed)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: "pending" });
  });
});

describe("payment_decide: one decision, exactly once", () => {
  it("a repeated accept returns the existing decision and begins nothing new", async () => {
    const f = await payFixture(db);
    await decide(db, f, "accepted");
    expect(await decide(db, f, "accepted")).toMatchObject({ ok: false, code: "DECISION_ALREADY_MADE", decision: "accepted" });
    expect((await f.attempt()).state).toBe("CAPTURE_IN_FLIGHT");
    expect(await f.reservation()).toMatchObject({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "capture" });
  });

  it("the opposite decision after one is made is refused, and no void is begun", async () => {
    const f = await payFixture(db);
    await decide(db, f, "accepted");
    expect(await decide(db, f, "declined", { reason: "Changed my mind." })).toMatchObject({ ok: false, code: "DECISION_ALREADY_MADE", decision: "accepted" });
    expect((await f.attempt()).state).toBe("CAPTURE_IN_FLIGHT");
    expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: "accepted", reason: null });
  });

  it("five simultaneous accepts: one decision, one capture begun", async () => {
    const f = await payFixture(db);
    const results = await Promise.all(Array.from({ length: 5 }, () => decide(db, f, "accepted")));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.code === "DECISION_ALREADY_MADE")).toHaveLength(4);
    expect((await f.attempt()).state).toBe("CAPTURE_IN_FLIGHT");
    expect(await f.reservation()).toMatchObject({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "capture" });
    await expectPaired(f);
  });

  it("a confirm racing a decline has exactly one winner, never a capture and a void together (12 rounds)", async () => {
    for (let i = 0; i < 12; i++) {
      const f = await payFixture(db);
      const [accept, decline] = await Promise.all([decide(db, f, "accepted"), decide(db, f, "declined", { reason: "No." })]);
      expect(Number(accept.ok) + Number(decline.ok), `round ${i}`).toBe(1);

      const winner = accept.ok ? "accepted" : "declined";
      const loser = accept.ok ? decline : accept;
      expect(loser).toMatchObject({ ok: false, code: "DECISION_ALREADY_MADE", decision: winner });
      expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: winner });
      expect((await f.attempt()).state, `round ${i}`).toBe(winner === "accepted" ? "CAPTURE_IN_FLIGHT" : "VOID_IN_FLIGHT");
      expect(await f.reservation(), `round ${i}`).toMatchObject({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: winner === "accepted" ? "capture" : "void" });
      await expectPaired(f);
    }
  });
});

describe("payment_decide: what must be true first", () => {
  it("is refused (NOT_FOUND) for a merchant who does not own the purchase, and changes nothing", async () => {
    const f = await payFixture(db);
    const other = await payFixture(db);
    expect(await decide(db, f, "accepted", { merchantId: other.merchantId })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: "pending" });
    expect((await f.attempt()).state).toBe("AUTHORIZED");
  });

  it("is refused when no payment is waiting for a decision", async () => {
    const approved = await payFixture(db, "APPROVED");
    expect(await decide(db, approved, "accepted")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await decide(db, { purchaseId: "00000000-0000-4000-8000-000000000000", merchantId: approved.merchantId }, "accepted")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("is refused while the payment is uncertain: nothing is captured or voided on a guess", async () => {
    // An uncertain authorize: no decision exists yet, so there is nothing to decide.
    const authorizing = await unknownFixture(db, "authorize");
    expect(await decide(db, authorizing, "accepted")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    // An uncertain capture: the merchant already accepted, so a decline is refused and no void is begun.
    const capturing = await unknownFixture(db, "capture");
    expect(await decide(db, capturing, "declined", { reason: "Changed my mind." })).toMatchObject({ ok: false, code: "DECISION_ALREADY_MADE", decision: "accepted" });
    expect((await capturing.attempt()).state).toBe("OUTCOME_UNKNOWN");
  });

  it("refuses an unknown decision value", async () => {
    const f = await payFixture(db);
    for (const decision of ["pending", "maybe", ""]) expect(await decide(db, f, decision), decision).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: "pending" });
  });
});

describe("payment_decide: rolls back when the begin is refused", () => {
  it("an accept after the authorization expired is blocked and the decision stays pending", async () => {
    const f = await payFixture(db);
    await db.from("payment_attempts").update({ authorization_expires_at: addMinutes(T0, 10) }).eq("id", f.attemptId);
    const r = await decide(db, f, "accepted", { now: addMinutes(T0, 11) });
    expect(r).toMatchObject({ ok: false, code: "CAPTURE_BLOCKED", cause: "the authorization has expired" });
    expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: "pending", decided_at: null });
    expect((await f.attempt()).state).toBe("AUTHORIZED");
    expect((await f.reservation())!.state).toBe("AWAITING_CONFIRMATION");
  });

  it("a decline is still possible after the authorization expired", async () => {
    const f = await payFixture(db);
    await db.from("payment_attempts").update({ authorization_expires_at: addMinutes(T0, 10) }).eq("id", f.attemptId);
    expect(await decide(db, f, "declined", { reason: "Too late.", now: addMinutes(T0, 11) })).toMatchObject({ ok: true, state: "VOID_IN_FLIGHT" });
  });

  it("a reservation that is not awaiting confirmation refuses, and the decision stays pending", async () => {
    const f = await payFixture(db);
    await db.rpc("flag_for_review", { p_reservation_id: f.reservationId, p_reason: "odd", p_now: T0 });
    const r = await decide(db, f, "accepted");
    expect(r).toMatchObject({ ok: false, code: "RESERVATION_REFUSED" });
    expect(await decisionOf(db, f.purchaseId)).toMatchObject({ decision: "pending", decided_at: null });
    expect((await f.attempt()).state).toBe("AUTHORIZED");
  });
});

describe("function privileges", () => {
  it("payment_decide cannot be called by the anon role", async () => {
    expect(codeOf(await anonClient().rpc("payment_decide", { p_purchase_id: "00000000-0000-4000-8000-000000000000", p_merchant_id: "00000000-0000-4000-8000-000000000000", p_decision: "accepted", p_confirmed_conditions: [], p_reason: null, p_now: T0 }))).toBe(SQLSTATE.denied);
  });
});
