export type AttemptState =
  | "CREATED"
  | "PROVIDER_CREATED"
  | "APPROVED"
  | "AUTHORIZE_IN_FLIGHT"
  | "AUTHORIZED"
  | "CAPTURE_IN_FLIGHT"
  | "CAPTURED"
  | "VOID_IN_FLIGHT"
  | "VOIDED"
  | "EXPIRED"
  | "FAILED"
  | "OUTCOME_UNKNOWN"
  | "EXCEPTION";

/** Every PayPal call this module makes. Creating an order moves no money; the other three can. */
export type Operation = "create" | "authorize" | "capture" | "void";

/** The operations that move money, which is what an in-flight state or an uncertain outcome is about. */
export type BeginOperation = "authorize" | "capture" | "void";

/**
 * What a settlement reports. A failure returns to the earlier state; AUTHORIZE_NOT_DONE is the reconciled
 * finding that an authorize never happened (the order is still approved); UNKNOWN is an answer that did not
 * settle the question; EXCEPTION is a financial mismatch.
 */
export type SettleOutcome =
  | "AUTHORIZED"
  | "AUTHORIZE_FAILED"
  | "AUTHORIZE_NOT_DONE"
  | "CAPTURED"
  | "CAPTURE_FAILED"
  | "VOIDED"
  | "VOID_FAILED"
  | "UNKNOWN"
  | "EXCEPTION";

export type AttemptEvent =
  | { type: "ORDER_CREATED" }
  | { type: "APPROVE" }
  | { type: "BEGIN"; operation: BeginOperation }
  | { type: "SETTLE"; outcome: SettleOutcome }
  /** PayPal's evidence resolves an uncertain operation. Only valid from OUTCOME_UNKNOWN. */
  | { type: "RESOLVE"; to: AttemptState }
  /** PayPal refused definitively, or reports the order void or expired. */
  | { type: "FAIL" }
  | { type: "EXPIRE" }
  /** A mismatch was found on an authorization that is waiting for the merchant. */
  | { type: "FLAG_EXCEPTION" };

/** What the stored row says, which some transitions depend on. */
export type TransitionContext = {
  /** The operation recorded while the state is OUTCOME_UNKNOWN. */
  unknownOperation?: BeginOperation | null;
};

/** Why a payment is a financial exception: never marked paid, stock held for a person. */
export type ExceptionReason =
  | "ORDER_MISMATCH"
  | "AUTHORIZATION_MISMATCH"
  | "STATUS_NOT_AS_EXPECTED"
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "PAYEE_MISMATCH"
  | "EVIDENCE_MISSING";

/** How a PayPal answer must be treated. */
export type Classification = "DONE" | "DEFINITIVE_FAILURE" | "UNKNOWN" | "NOT_SENT";

/** Stable codes; other modules match on them. */
export type PaymentErrorCode =
  | "PURCHASE_NOT_FOUND"
  | "QUOTE_NOT_ACCEPTED"
  | "RESERVATION_REFUSED"
  | "ATTEMPT_ACTIVE"
  | "NOT_APPROVED"
  | "PROVIDER_REFUSED"
  | "PROVIDER_UNREACHABLE"
  | "OUTCOME_UNKNOWN"
  | "FINANCIAL_EXCEPTION"
  | "DECISION_ALREADY_MADE"
  | "CONDITIONS_UNCONFIRMED"
  | "REASON_REQUIRED"
  | "CAPTURE_BLOCKED"
  | "ALREADY_CAPTURED"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "ILLEGAL_TRANSITION";

export type PaymentResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PaymentErrorCode; cause?: string; reasons?: ExceptionReason[] };
