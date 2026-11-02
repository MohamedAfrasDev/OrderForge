import type { ReservationState } from "@/domain/reservation";
import type { AttemptEvent, AttemptState, BeginOperation, SettleOutcome, TransitionContext } from "./types";

export type { AttemptEvent, AttemptState, BeginOperation, Operation, SettleOutcome, TransitionContext } from "./types";

export const ATTEMPT_STATES: readonly AttemptState[] = [
  "CREATED",
  "PROVIDER_CREATED",
  "APPROVED",
  "AUTHORIZE_IN_FLIGHT",
  "AUTHORIZED",
  "CAPTURE_IN_FLIGHT",
  "CAPTURED",
  "VOID_IN_FLIGHT",
  "VOIDED",
  "EXPIRED",
  "FAILED",
  "OUTCOME_UNKNOWN",
  "EXCEPTION",
];
export const BEGIN_OPERATIONS: readonly BeginOperation[] = ["authorize", "capture", "void"];
export const SETTLE_OUTCOMES: readonly SettleOutcome[] = [
  "AUTHORIZED",
  "AUTHORIZE_FAILED",
  "AUTHORIZE_NOT_DONE",
  "CAPTURED",
  "CAPTURE_FAILED",
  "VOIDED",
  "VOID_FAILED",
  "UNKNOWN",
  "EXCEPTION",
];

/** States with no way out. EXCEPTION is one of them: a person deals with it outside the app in v1. */
export const TERMINAL_STATES: readonly AttemptState[] = ["CAPTURED", "VOIDED", "EXPIRED", "FAILED", "EXCEPTION"];
export const IN_FLIGHT_STATES: readonly AttemptState[] = ["AUTHORIZE_IN_FLIGHT", "CAPTURE_IN_FLIGHT", "VOID_IN_FLIGHT"];

/**
 * Active means it still blocks a new attempt: everything except CAPTURED, VOIDED, EXPIRED and FAILED. This is the same
 * rule as the database's one-active-attempt index, so a final EXCEPTION (and any OUTCOME_UNKNOWN) stays active.
 */
export const isActive = (state: AttemptState): boolean => !["CAPTURED", "VOIDED", "EXPIRED", "FAILED"].includes(state);

export function inFlightOperationOf(state: AttemptState): BeginOperation | null {
  switch (state) {
    case "AUTHORIZE_IN_FLIGHT":
      return "authorize";
    case "CAPTURE_IN_FLIGHT":
      return "capture";
    case "VOID_IN_FLIGHT":
      return "void";
    default:
      return null;
  }
}

/**
 * The reservation states an attempt state may be paired with. The database moves both in one transaction, so a test can
 * assert this after every transition. Before authorization the hold is still held (or has just run out).
 */
export const PAIRED_RESERVATION_STATES: Record<AttemptState, readonly ReservationState[]> = {
  CREATED: ["HELD", "RELEASED"],
  PROVIDER_CREATED: ["HELD", "RELEASED"],
  APPROVED: ["HELD", "RELEASED"],
  AUTHORIZE_IN_FLIGHT: ["PAYMENT_IN_FLIGHT"],
  AUTHORIZED: ["AWAITING_CONFIRMATION"],
  CAPTURE_IN_FLIGHT: ["PAYMENT_IN_FLIGHT"],
  CAPTURED: ["COMMITTED"],
  VOID_IN_FLIGHT: ["PAYMENT_IN_FLIGHT"],
  VOIDED: ["RELEASED"],
  EXPIRED: ["HELD", "RELEASED"],
  FAILED: ["HELD", "RELEASED"],
  OUTCOME_UNKNOWN: ["REVIEW_REQUIRED"],
  EXCEPTION: ["REVIEW_REQUIRED"],
};

const ILLEGAL = { error: "ILLEGAL_TRANSITION" } as const;

/** Keys are "EVENT" or "EVENT:detail". */
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

/** What PayPal's evidence may resolve an uncertain operation to. Only from OUTCOME_UNKNOWN, and never by retrying first. */
const RESOLUTIONS: Record<BeginOperation, readonly AttemptState[]> = {
  authorize: ["AUTHORIZED", "APPROVED", "FAILED", "EXCEPTION"],
  capture: ["CAPTURED", "AUTHORIZED", "EXCEPTION"],
  void: ["VOIDED", "AUTHORIZED", "EXCEPTION"],
};

function keyOf(event: Exclude<AttemptEvent, { type: "RESOLVE" }>): string {
  switch (event.type) {
    case "BEGIN":
      return `BEGIN:${event.operation}`;
    case "SETTLE":
      return `SETTLE:${event.outcome}`;
    default:
      return event.type;
  }
}

/**
 * The only payment attempt state machine. The database trigger in migration 0007 enforces the same table.
 * A call that is not in the table is ILLEGAL_TRANSITION. An uncertain outcome can only be resolved from
 * OUTCOME_UNKNOWN, by the operation that was uncertain.
 */
export function transition(from: AttemptState, event: AttemptEvent, context: TransitionContext = {}): AttemptState | typeof ILLEGAL {
  if (event.type === "RESOLVE") {
    const operation = context.unknownOperation;
    if (from !== "OUTCOME_UNKNOWN" || !operation) return ILLEGAL;
    return RESOLUTIONS[operation].includes(event.to) ? event.to : ILLEGAL;
  }
  return TABLE[from][keyOf(event)] ?? ILLEGAL;
}
