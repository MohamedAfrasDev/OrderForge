import { describe, expect, it } from "vitest";
import {
  ATTEMPT_STATES,
  BEGIN_OPERATIONS,
  IN_FLIGHT_STATES,
  PAIRED_RESERVATION_STATES,
  SETTLE_OUTCOMES,
  TERMINAL_STATES,
  inFlightOperationOf,
  isActive,
  transition,
  type AttemptEvent,
  type AttemptState,
  type BeginOperation,
} from "@/domain/payments/state";

const ILLEGAL = { error: "ILLEGAL_TRANSITION" } as const;

// The spec's table, written out independently of the implementation. Keys are "EVENT" or "EVENT:detail".
const TABLE: Record<AttemptState, Record<string, AttemptState>> = {
  CREATED: { ORDER_CREATED: "PROVIDER_CREATED", FAIL: "FAILED", EXPIRE: "EXPIRED" },
  PROVIDER_CREATED: { APPROVE: "APPROVED", EXPIRE: "EXPIRED", FAIL: "FAILED" },
  APPROVED: { "BEGIN:authorize": "AUTHORIZE_IN_FLIGHT", EXPIRE: "EXPIRED", FAIL: "FAILED" },
  AUTHORIZE_IN_FLIGHT: {
    "SETTLE:AUTHORIZED": "AUTHORIZED",
    "SETTLE:AUTHORIZE_FAILED": "FAILED",
    "SETTLE:AUTHORIZE_NOT_DONE": "APPROVED",
    "SETTLE:UNKNOWN": "OUTCOME_UNKNOWN",
    "SETTLE:EXCEPTION": "EXCEPTION",
  },
  AUTHORIZED: { "BEGIN:capture": "CAPTURE_IN_FLIGHT", "BEGIN:void": "VOID_IN_FLIGHT", EXPIRE: "EXPIRED", FLAG_EXCEPTION: "EXCEPTION" },
  CAPTURE_IN_FLIGHT: {
    "SETTLE:CAPTURED": "CAPTURED",
    "SETTLE:CAPTURE_FAILED": "AUTHORIZED",
    "SETTLE:UNKNOWN": "OUTCOME_UNKNOWN",
    "SETTLE:EXCEPTION": "EXCEPTION",
  },
  VOID_IN_FLIGHT: {
    "SETTLE:VOIDED": "VOIDED",
    "SETTLE:VOID_FAILED": "AUTHORIZED",
    "SETTLE:UNKNOWN": "OUTCOME_UNKNOWN",
    "SETTLE:EXCEPTION": "EXCEPTION",
  },
  OUTCOME_UNKNOWN: {},
  CAPTURED: {},
  VOIDED: {},
  EXPIRED: {},
  FAILED: {},
  EXCEPTION: {},
};

// What PayPal's evidence may resolve an uncertain operation to (spec assumption 9). Only from OUTCOME_UNKNOWN.
const RESOLUTIONS: Record<BeginOperation, AttemptState[]> = {
  authorize: ["AUTHORIZED", "APPROVED", "FAILED", "EXCEPTION"],
  capture: ["CAPTURED", "AUTHORIZED", "EXCEPTION"],
  void: ["VOIDED", "AUTHORIZED", "EXCEPTION"],
};

const key = (event: AttemptEvent): string => {
  switch (event.type) {
    case "BEGIN":
      return `BEGIN:${event.operation}`;
    case "SETTLE":
      return `SETTLE:${event.outcome}`;
    default:
      return event.type;
  }
};

const EVENTS: AttemptEvent[] = [
  { type: "ORDER_CREATED" },
  { type: "APPROVE" },
  ...BEGIN_OPERATIONS.map((operation) => ({ type: "BEGIN", operation }) as const),
  ...SETTLE_OUTCOMES.map((outcome) => ({ type: "SETTLE", outcome }) as const),
  { type: "FAIL" },
  { type: "EXPIRE" },
  { type: "FLAG_EXCEPTION" },
  ...ATTEMPT_STATES.map((to) => ({ type: "RESOLVE", to }) as const),
];

describe("transition: the whole table", () => {
  it("lists every state", () => {
    expect(ATTEMPT_STATES).toHaveLength(13);
    expect(Object.keys(TABLE).sort()).toEqual([...ATTEMPT_STATES].sort());
  });

  it("every state, event and recorded unknown operation gives the listed target, or ILLEGAL_TRANSITION", () => {
    for (const from of ATTEMPT_STATES) {
      for (const event of EVENTS) {
        for (const unknownOperation of [null, ...BEGIN_OPERATIONS] as const) {
          let expected: AttemptState | typeof ILLEGAL = ILLEGAL;
          if (event.type === "RESOLVE") {
            if (from === "OUTCOME_UNKNOWN" && unknownOperation && RESOLUTIONS[unknownOperation].includes(event.to)) expected = event.to;
          } else {
            expected = TABLE[from][key(event)] ?? ILLEGAL;
          }
          expect(transition(from, event, { unknownOperation }), `${from} + ${key(event)}${event.type === "RESOLVE" ? ` -> ${event.to}` : ""} (unknown: ${unknownOperation})`).toEqual(expected);
        }
      }
    }
  });

  it("an uncertain operation must be recorded before it can be resolved", () => {
    expect(transition("OUTCOME_UNKNOWN", { type: "RESOLVE", to: "AUTHORIZED" }, {})).toEqual(ILLEGAL);
    expect(transition("OUTCOME_UNKNOWN", { type: "RESOLVE", to: "AUTHORIZED" })).toEqual(ILLEGAL);
  });

  it("the terminal states have no way out, under any event", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(["CAPTURED", "EXCEPTION", "EXPIRED", "FAILED", "VOIDED"]);
    for (const from of TERMINAL_STATES) {
      for (const event of EVENTS) {
        for (const unknownOperation of [null, ...BEGIN_OPERATIONS] as const) {
          expect(transition(from, event, { unknownOperation })).toEqual(ILLEGAL);
        }
      }
    }
  });

  it("a settlement outcome only fits the operation in flight: a capture cannot settle an authorize", () => {
    expect(transition("AUTHORIZE_IN_FLIGHT", { type: "SETTLE", outcome: "CAPTURED" })).toEqual(ILLEGAL);
    expect(transition("CAPTURE_IN_FLIGHT", { type: "SETTLE", outcome: "AUTHORIZED" })).toEqual(ILLEGAL);
    expect(transition("CAPTURE_IN_FLIGHT", { type: "SETTLE", outcome: "VOIDED" })).toEqual(ILLEGAL);
    expect(transition("VOID_IN_FLIGHT", { type: "SETTLE", outcome: "CAPTURED" })).toEqual(ILLEGAL);
  });

  it("a capture and a void can never both be begun from the same authorization (the second leaves AUTHORIZED)", () => {
    const afterCapture = transition("AUTHORIZED", { type: "BEGIN", operation: "capture" });
    expect(afterCapture).toBe("CAPTURE_IN_FLIGHT");
    expect(transition(afterCapture as AttemptState, { type: "BEGIN", operation: "void" })).toEqual(ILLEGAL);
    const afterVoid = transition("AUTHORIZED", { type: "BEGIN", operation: "void" });
    expect(afterVoid).toBe("VOID_IN_FLIGHT");
    expect(transition(afterVoid as AttemptState, { type: "BEGIN", operation: "capture" })).toEqual(ILLEGAL);
  });

  it("never returns an unknown state, and a terminal state is never left (seeded walk)", () => {
    let seed = 20261102;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let run = 0; run < 40; run++) {
      let state: AttemptState = "CREATED";
      let unknownOperation: BeginOperation | null = null;
      let reachedTerminal = false;
      for (let i = 0; i < 400; i++) {
        const event = EVENTS[next() % EVENTS.length]!;
        const result = transition(state, event, { unknownOperation });
        if (typeof result === "string") {
          expect(ATTEMPT_STATES).toContain(result);
          if (reachedTerminal) throw new Error("left a terminal state");
          if (result === "OUTCOME_UNKNOWN") unknownOperation = inFlightOperationOf(state);
          else if (state === "OUTCOME_UNKNOWN") unknownOperation = null;
          state = result;
          if (TERMINAL_STATES.includes(state)) reachedTerminal = true;
        }
      }
    }
  });
});

describe("active attempts", () => {
  it("matches the database's one-active-attempt rule: everything except CAPTURED, VOIDED, EXPIRED and FAILED", () => {
    expect(ATTEMPT_STATES.filter((s) => !isActive(s)).sort()).toEqual(["CAPTURED", "EXPIRED", "FAILED", "VOIDED"]);
  });

  it("EXCEPTION is final but still active, so it blocks a new attempt until a person deals with it", () => {
    expect(isActive("EXCEPTION")).toBe(true);
    expect(TERMINAL_STATES).toContain("EXCEPTION");
  });

  it("OUTCOME_UNKNOWN is active: never a new attempt while one is uncertain", () => {
    expect(isActive("OUTCOME_UNKNOWN")).toBe(true);
  });
});

describe("in flight", () => {
  it("names the operation each in-flight state is for", () => {
    expect([...IN_FLIGHT_STATES]).toEqual(["AUTHORIZE_IN_FLIGHT", "CAPTURE_IN_FLIGHT", "VOID_IN_FLIGHT"]);
    expect(inFlightOperationOf("AUTHORIZE_IN_FLIGHT")).toBe("authorize");
    expect(inFlightOperationOf("CAPTURE_IN_FLIGHT")).toBe("capture");
    expect(inFlightOperationOf("VOID_IN_FLIGHT")).toBe("void");
    for (const s of ATTEMPT_STATES.filter((x) => !IN_FLIGHT_STATES.includes(x))) expect(inFlightOperationOf(s), s).toBeNull();
  });
});

describe("pairing with the reservation", () => {
  it("every attempt state names the reservation states it may be paired with", () => {
    expect(Object.keys(PAIRED_RESERVATION_STATES).sort()).toEqual([...ATTEMPT_STATES].sort());
  });

  it("the states that move money pair with exactly one reservation state", () => {
    expect(PAIRED_RESERVATION_STATES.AUTHORIZE_IN_FLIGHT).toEqual(["PAYMENT_IN_FLIGHT"]);
    expect(PAIRED_RESERVATION_STATES.CAPTURE_IN_FLIGHT).toEqual(["PAYMENT_IN_FLIGHT"]);
    expect(PAIRED_RESERVATION_STATES.VOID_IN_FLIGHT).toEqual(["PAYMENT_IN_FLIGHT"]);
    expect(PAIRED_RESERVATION_STATES.AUTHORIZED).toEqual(["AWAITING_CONFIRMATION"]);
    expect(PAIRED_RESERVATION_STATES.CAPTURED).toEqual(["COMMITTED"]);
    expect(PAIRED_RESERVATION_STATES.VOIDED).toEqual(["RELEASED"]);
    expect(PAIRED_RESERVATION_STATES.OUTCOME_UNKNOWN).toEqual(["REVIEW_REQUIRED"]);
    expect(PAIRED_RESERVATION_STATES.EXCEPTION).toEqual(["REVIEW_REQUIRED"]);
  });

  it("before authorization the hold is still held (or has run out)", () => {
    for (const s of ["CREATED", "PROVIDER_CREATED", "APPROVED"] as const) expect(PAIRED_RESERVATION_STATES[s], s).toEqual(["HELD", "RELEASED"]);
  });

  it("a stock-holding attempt state never pairs with COMMITTED, and only CAPTURED does", () => {
    for (const s of ATTEMPT_STATES) {
      expect(PAIRED_RESERVATION_STATES[s].includes("COMMITTED"), s).toBe(s === "CAPTURED");
    }
  });
});
