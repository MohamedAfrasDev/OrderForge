import { describe, expect, it } from "vitest";
import {
  LIVE_STATES,
  OPERATIONS,
  RESERVATION_STATES,
  SETTLE_OUTCOMES,
  isLive,
  outcomeOperation,
  stockEffect,
  transition,
  type Operation,
  type ReservationEvent,
  type ReservationState,
  type SettleOutcome,
} from "@/domain/reservation/state";

const ILLEGAL = { error: "ILLEGAL_TRANSITION" } as const;

describe("transition: begin an operation", () => {
  it("only authorize from HELD, and only capture or void from AWAITING_CONFIRMATION", () => {
    for (const from of RESERVATION_STATES) {
      for (const operation of OPERATIONS) {
        const legal =
          (from === "HELD" && operation === "authorize") ||
          (from === "AWAITING_CONFIRMATION" && (operation === "capture" || operation === "void"));
        const result = transition(from, { type: "BEGIN", operation }, {});
        expect(result, `${from} begin ${operation}`).toEqual(legal ? "PAYMENT_IN_FLIGHT" : ILLEGAL);
      }
    }
  });
});

describe("transition: settle an operation", () => {
  // The spec's table, written out independently of the implementation.
  const SETTLES: Array<[SettleOutcome, Operation | "any", ReservationState]> = [
    ["AUTHORIZED", "authorize", "AWAITING_CONFIRMATION"],
    ["AUTHORIZE_FAILED", "authorize", "HELD"],
    ["CAPTURED", "capture", "COMMITTED"],
    ["CAPTURE_FAILED", "capture", "AWAITING_CONFIRMATION"],
    ["VOIDED", "void", "RELEASED"],
    ["VOID_FAILED", "void", "AWAITING_CONFIRMATION"],
    ["UNKNOWN", "any", "REVIEW_REQUIRED"],
  ];

  it("every outcome with every recorded operation: the listed target, or illegal when they do not match", () => {
    for (const [outcome, forOp, target] of SETTLES) {
      for (const operation of OPERATIONS) {
        const matches = forOp === "any" || forOp === operation;
        expect(transition("PAYMENT_IN_FLIGHT", { type: "SETTLE", outcome }, { inFlightOperation: operation }), `${outcome} while ${operation}`).toEqual(
          matches ? target : ILLEGAL,
        );
      }
    }
  });

  it("is illegal when no operation is recorded, and from any state other than PAYMENT_IN_FLIGHT", () => {
    for (const outcome of SETTLE_OUTCOMES) {
      expect(transition("PAYMENT_IN_FLIGHT", { type: "SETTLE", outcome }, {})).toEqual(ILLEGAL);
      for (const from of RESERVATION_STATES.filter((s) => s !== "PAYMENT_IN_FLIGHT")) {
        for (const operation of OPERATIONS) {
          expect(transition(from, { type: "SETTLE", outcome }, { inFlightOperation: operation }), `${from} settle ${outcome}`).toEqual(ILLEGAL);
        }
      }
    }
  });

  it("outcomeOperation names the operation each outcome belongs to", () => {
    expect(outcomeOperation("AUTHORIZED")).toBe("authorize");
    expect(outcomeOperation("AUTHORIZE_FAILED")).toBe("authorize");
    expect(outcomeOperation("CAPTURED")).toBe("capture");
    expect(outcomeOperation("CAPTURE_FAILED")).toBe("capture");
    expect(outcomeOperation("VOIDED")).toBe("void");
    expect(outcomeOperation("VOID_FAILED")).toBe("void");
    expect(outcomeOperation("UNKNOWN")).toBeNull();
  });
});

describe("transition: release, re-hold, review, resolve", () => {
  it("a timer-style release works only from HELD", () => {
    for (const from of RESERVATION_STATES) {
      for (const reason of ["EXPIRED", "SUPERSEDED", "ABANDONED"] as const) {
        expect(transition(from, { type: "RELEASE", reason }, {}), `${from} release ${reason}`).toEqual(from === "HELD" ? "RELEASED" : ILLEGAL);
      }
    }
  });

  it("DECLINED and VOIDED are produced by a void settlement, never by a plain release", () => {
    for (const reason of ["DECLINED", "VOIDED"] as const) {
      expect(transition("HELD", { type: "RELEASE", reason }, {})).toEqual(ILLEGAL);
    }
  });

  it("a release can be re-held only when it was an expiry", () => {
    expect(transition("RELEASED", { type: "REHOLD" }, { releaseReason: "EXPIRED" })).toBe("HELD");
    for (const reason of ["SUPERSEDED", "ABANDONED", "DECLINED", "VOIDED"] as const) {
      expect(transition("RELEASED", { type: "REHOLD" }, { releaseReason: reason }), reason).toEqual(ILLEGAL);
    }
    expect(transition("RELEASED", { type: "REHOLD" }, {})).toEqual(ILLEGAL);
    for (const from of RESERVATION_STATES.filter((s) => s !== "RELEASED")) {
      expect(transition(from, { type: "REHOLD" }, { releaseReason: "EXPIRED" }), from).toEqual(ILLEGAL);
    }
  });

  it("flagging for review works from PAYMENT_IN_FLIGHT and AWAITING_CONFIRMATION only", () => {
    for (const from of RESERVATION_STATES) {
      const legal = from === "PAYMENT_IN_FLIGHT" || from === "AWAITING_CONFIRMATION";
      expect(transition(from, { type: "FLAG_REVIEW" }, {}), from).toEqual(legal ? "REVIEW_REQUIRED" : ILLEGAL);
    }
  });

  it("resolving leaves REVIEW_REQUIRED only, and only to the four allowed targets", () => {
    const targets = ["HELD", "AWAITING_CONFIRMATION", "COMMITTED", "RELEASED"] as const;
    for (const from of RESERVATION_STATES) {
      for (const target of RESERVATION_STATES) {
        const legal = from === "REVIEW_REQUIRED" && (targets as readonly string[]).includes(target);
        expect(transition(from, { type: "RESOLVE", target }, {}), `${from} resolve ${target}`).toEqual(legal ? target : ILLEGAL);
      }
    }
  });

  it("COMMITTED is final: no event leaves it", () => {
    const events: ReservationEvent[] = [
      ...OPERATIONS.map((operation) => ({ type: "BEGIN", operation }) as const),
      ...SETTLE_OUTCOMES.map((outcome) => ({ type: "SETTLE", outcome }) as const),
      { type: "RELEASE", reason: "EXPIRED" },
      { type: "REHOLD" },
      { type: "FLAG_REVIEW" },
      ...RESERVATION_STATES.map((target) => ({ type: "RESOLVE", target }) as const),
    ];
    for (const event of events) {
      for (const operation of OPERATIONS) {
        expect(transition("COMMITTED", event, { inFlightOperation: operation, releaseReason: "EXPIRED" })).toEqual(ILLEGAL);
      }
    }
  });

  it("never returns an unknown state (seeded walk over every event)", () => {
    let seed = 99;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    const events: ReservationEvent[] = [
      ...OPERATIONS.map((operation) => ({ type: "BEGIN", operation }) as const),
      ...SETTLE_OUTCOMES.map((outcome) => ({ type: "SETTLE", outcome }) as const),
      { type: "RELEASE", reason: "EXPIRED" },
      { type: "REHOLD" },
      { type: "FLAG_REVIEW" },
      ...RESERVATION_STATES.map((target) => ({ type: "RESOLVE", target }) as const),
    ];
    let state: ReservationState = "HELD";
    let inFlight: Operation | undefined;
    for (let i = 0; i < 2000; i++) {
      const event = events[next() % events.length]!;
      const result = transition(state, event, { inFlightOperation: inFlight, releaseReason: "EXPIRED" });
      if (typeof result === "string") {
        expect(RESERVATION_STATES).toContain(result);
        inFlight = event.type === "BEGIN" ? event.operation : result === "PAYMENT_IN_FLIGHT" ? inFlight : undefined;
        state = result;
      }
    }
  });
});

describe("live states and stock effects", () => {
  it("live means holding stock: HELD, PAYMENT_IN_FLIGHT, AWAITING_CONFIRMATION, REVIEW_REQUIRED", () => {
    expect([...LIVE_STATES]).toEqual(["HELD", "PAYMENT_IN_FLIGHT", "AWAITING_CONFIRMATION", "REVIEW_REQUIRED"]);
    expect(RESERVATION_STATES.filter(isLive)).toEqual([...LIVE_STATES]);
    expect(isLive("COMMITTED")).toBe(false);
    expect(isLive("RELEASED")).toBe(false);
  });

  it("reserve and re-hold reserve; release and void release; capture commits; everything else does nothing", () => {
    expect(stockEffect(null, "HELD")).toBe("RESERVE");
    expect(stockEffect("RELEASED", "HELD")).toBe("RESERVE");
    expect(stockEffect("HELD", "RELEASED")).toBe("RELEASE");
    expect(stockEffect("PAYMENT_IN_FLIGHT", "RELEASED")).toBe("RELEASE");
    expect(stockEffect("REVIEW_REQUIRED", "RELEASED")).toBe("RELEASE");
    expect(stockEffect("PAYMENT_IN_FLIGHT", "COMMITTED")).toBe("COMMIT");
    expect(stockEffect("REVIEW_REQUIRED", "COMMITTED")).toBe("COMMIT");
    expect(stockEffect("HELD", "PAYMENT_IN_FLIGHT")).toBe("NONE");
    expect(stockEffect("PAYMENT_IN_FLIGHT", "AWAITING_CONFIRMATION")).toBe("NONE");
    expect(stockEffect("REVIEW_REQUIRED", "HELD")).toBe("NONE");
    expect(stockEffect("AWAITING_CONFIRMATION", "REVIEW_REQUIRED")).toBe("NONE");
  });

  it("applying the effects along any legal walk keeps reserved equal to the quantity on live reservations", () => {
    // One reservation of quantity 7 on a product with 100 on hand. Applying stockEffect at each legal move must
    // keep reserved == 7 while the reservation is live and 0 once it is released or committed.
    let seed = 4242;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    const events: ReservationEvent[] = [
      ...OPERATIONS.map((operation) => ({ type: "BEGIN", operation }) as const),
      ...SETTLE_OUTCOMES.map((outcome) => ({ type: "SETTLE", outcome }) as const),
      { type: "RELEASE", reason: "EXPIRED" },
      { type: "REHOLD" },
      { type: "FLAG_REVIEW" },
      ...RESERVATION_STATES.map((target) => ({ type: "RESOLVE", target }) as const),
    ];
    const Q = 7;
    for (let run = 0; run < 50; run++) {
      let state: ReservationState | null = null;
      let inFlight: Operation | undefined;
      let onHand = 100;
      let reserved = 0;
      const apply = (to: ReservationState) => {
        const effect = stockEffect(state, to);
        if (effect === "RESERVE") reserved += Q;
        if (effect === "RELEASE") reserved -= Q;
        if (effect === "COMMIT") {
          reserved -= Q;
          onHand -= Q;
        }
        state = to;
      };
      apply("HELD");
      for (let i = 0; i < 300; i++) {
        const event = events[next() % events.length]!;
        const current: ReservationState = state!;
        const result = transition(current, event, { inFlightOperation: inFlight, releaseReason: "EXPIRED" });
        if (typeof result !== "string") continue;
        inFlight = event.type === "BEGIN" ? event.operation : result === "PAYMENT_IN_FLIGHT" ? inFlight : undefined;
        apply(result);
        expect(reserved).toBe(isLive(result) ? Q : 0);
        expect(reserved).toBeGreaterThanOrEqual(0);
        expect(reserved).toBeLessThanOrEqual(onHand);
        expect(onHand).toBe(result === "COMMITTED" ? 100 - Q : onHand);
      }
    }
  });
});
