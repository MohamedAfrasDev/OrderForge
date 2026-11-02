import type {
  Operation,
  ReservationEvent,
  ReservationState,
  SettleOutcome,
  StockEffect,
  TransitionContext,
} from "./types";

export type { Operation, ReservationEvent, ReservationState, SettleOutcome, StockEffect, TransitionContext } from "./types";

export const RESERVATION_STATES: readonly ReservationState[] = [
  "HELD",
  "PAYMENT_IN_FLIGHT",
  "AWAITING_CONFIRMATION",
  "COMMITTED",
  "RELEASED",
  "REVIEW_REQUIRED",
];
export const OPERATIONS: readonly Operation[] = ["authorize", "capture", "void"];
export const SETTLE_OUTCOMES: readonly SettleOutcome[] = [
  "AUTHORIZED",
  "AUTHORIZE_FAILED",
  "CAPTURED",
  "CAPTURE_FAILED",
  "VOIDED",
  "VOID_FAILED",
  "UNKNOWN",
];

/** States that hold stock. `reserved` on a product must equal the quantity on these reservations. */
export const LIVE_STATES: readonly ReservationState[] = ["HELD", "PAYMENT_IN_FLIGHT", "AWAITING_CONFIRMATION", "REVIEW_REQUIRED"];
export const isLive = (state: ReservationState): boolean => LIVE_STATES.includes(state);

const ILLEGAL = { error: "ILLEGAL_TRANSITION" } as const;

/** The operation an outcome reports on. UNKNOWN can follow any operation. */
export function outcomeOperation(outcome: SettleOutcome): Operation | null {
  switch (outcome) {
    case "AUTHORIZED":
    case "AUTHORIZE_FAILED":
      return "authorize";
    case "CAPTURED":
    case "CAPTURE_FAILED":
      return "capture";
    case "VOIDED":
    case "VOID_FAILED":
      return "void";
    case "UNKNOWN":
      return null;
  }
}

const SETTLE_TARGET: Record<SettleOutcome, ReservationState> = {
  AUTHORIZED: "AWAITING_CONFIRMATION",
  AUTHORIZE_FAILED: "HELD",
  CAPTURED: "COMMITTED",
  CAPTURE_FAILED: "AWAITING_CONFIRMATION",
  VOIDED: "RELEASED",
  VOID_FAILED: "AWAITING_CONFIRMATION",
  UNKNOWN: "REVIEW_REQUIRED",
};

/** A plain release is for a hold nobody is acting on. DECLINED and VOIDED come only from a void settlement. */
const PLAIN_RELEASE_REASONS = new Set(["EXPIRED", "SUPERSEDED", "ABANDONED"]);
const RESOLVE_TARGETS = new Set<ReservationState>(["HELD", "AWAITING_CONFIRMATION", "COMMITTED", "RELEASED"]);

/**
 * The only reservation state machine. The database trigger in migration 0006 enforces the same table.
 * A call that is not in the table is ILLEGAL_TRANSITION; reserving is not an event (it creates the first state).
 */
export function transition(
  from: ReservationState,
  event: ReservationEvent,
  context: TransitionContext = {},
): ReservationState | typeof ILLEGAL {
  switch (event.type) {
    case "BEGIN":
      if (from === "HELD" && event.operation === "authorize") return "PAYMENT_IN_FLIGHT";
      if (from === "AWAITING_CONFIRMATION" && (event.operation === "capture" || event.operation === "void")) {
        return "PAYMENT_IN_FLIGHT";
      }
      return ILLEGAL;

    case "SETTLE": {
      if (from !== "PAYMENT_IN_FLIGHT") return ILLEGAL;
      const recorded = context.inFlightOperation;
      if (!recorded) return ILLEGAL;
      const owner = outcomeOperation(event.outcome);
      if (owner !== null && owner !== recorded) return ILLEGAL;
      return SETTLE_TARGET[event.outcome];
    }

    case "RELEASE":
      return from === "HELD" && PLAIN_RELEASE_REASONS.has(event.reason) ? "RELEASED" : ILLEGAL;

    case "REHOLD":
      return from === "RELEASED" && context.releaseReason === "EXPIRED" ? "HELD" : ILLEGAL;

    case "FLAG_REVIEW":
      return from === "PAYMENT_IN_FLIGHT" || from === "AWAITING_CONFIRMATION" ? "REVIEW_REQUIRED" : ILLEGAL;

    case "RESOLVE":
      return from === "REVIEW_REQUIRED" && RESOLVE_TARGETS.has(event.target) ? event.target : ILLEGAL;
  }
}

/**
 * What moving from one state to another does to stock. `from` is null for the first reservation of a purchase.
 * Exactly one effect per move, which is what keeps `reserved` equal to the quantity on live reservations.
 */
export function stockEffect(from: ReservationState | null, to: ReservationState): StockEffect {
  if (to === "HELD" && (from === null || from === "RELEASED")) return "RESERVE";
  if (to === "RELEASED") return "RELEASE";
  if (to === "COMMITTED") return "COMMIT";
  return "NONE";
}
