export type ReservationState =
  | "HELD"
  | "PAYMENT_IN_FLIGHT"
  | "AWAITING_CONFIRMATION"
  | "COMMITTED"
  | "RELEASED"
  | "REVIEW_REQUIRED";

/** A PayPal operation that could move money. Payments must begin one before sending it. */
export type Operation = "authorize" | "capture" | "void";

export type SettleOutcome =
  | "AUTHORIZED"
  | "AUTHORIZE_FAILED"
  | "CAPTURED"
  | "CAPTURE_FAILED"
  | "VOIDED"
  | "VOID_FAILED"
  | "UNKNOWN";

export type ReleaseReason = "EXPIRED" | "SUPERSEDED" | "ABANDONED" | "DECLINED" | "VOIDED";

/** What can happen to a reservation. Reserving itself is not an event: it creates the first state. */
export type ReservationEvent =
  | { type: "BEGIN"; operation: Operation }
  | { type: "SETTLE"; outcome: SettleOutcome }
  | { type: "RELEASE"; reason: ReleaseReason }
  | { type: "REHOLD" }
  | { type: "FLAG_REVIEW" }
  | { type: "RESOLVE"; target: ReservationState };

/** What the stored row says, which some transitions depend on. */
export type TransitionContext = {
  /** The operation recorded while the state is PAYMENT_IN_FLIGHT. */
  inFlightOperation?: Operation | null;
  /** The reason recorded while the state is RELEASED. */
  releaseReason?: ReleaseReason | null;
};

/** What a state change does to the stock row of each reserved product. */
export type StockEffect = "RESERVE" | "RELEASE" | "COMMIT" | "NONE";

/** Stable codes; other modules match on them. */
export type ReservationErrorCode =
  | "INSUFFICIENT_STOCK"
  | "NOT_FOUND"
  | "QUOTE_NOT_ACCEPTED"
  | "HOLD_EXPIRED"
  | "NOT_HELD"
  | "OPERATION_IN_FLIGHT"
  | "NO_OPERATION_IN_FLIGHT"
  | "OUTCOME_MISMATCH"
  | "ILLEGAL_TRANSITION"
  | "PAYMENT_ACTIVE"
  | "INVALID_INPUT";

export type Shortage = { productId: string; needed: number; available: number };

export type ReservationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ReservationErrorCode; shortages?: Shortage[]; cause?: string };

export type ProductQuantity = { productId: string; quantity: number };
