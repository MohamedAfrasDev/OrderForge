export const FIELD_STATUSES = ["confirmed", "needs_confirmation", "conflicted", "unknown"] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

/** The customer message a value came from, or "customer_edit" when the customer typed it into the summary themselves. */
export type Source = string | "customer_edit" | null;

export type Field<T> = { value: T | null; status: FieldStatus; source: Source };

export const FIELD_NAMES = ["boxCount", "noFood", "logoRequired", "maxPricePerBoxMinor", "requestedPickupDate", "preferences"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

/** One version of what the customer wants. Each field says how sure we are and where it came from. */
export type RequirementsDoc = {
  boxCount: Field<number>;
  noFood: Field<boolean>;
  logoRequired: Field<boolean>;
  maxPricePerBoxMinor: Field<number>;
  requestedPickupDate: Field<string>;
  /** Soft preferences in the customer's words ("notebooks"). Never block a quote. */
  preferences: Field<string[]>;
};

/** The fields that can hold a quote back. `preferences` is deliberately not one of them. */
export const BLOCKING_FIELDS = ["boxCount", "noFood", "logoRequired", "maxPricePerBoxMinor", "requestedPickupDate"] as const;
export type BlockingField = (typeof BLOCKING_FIELDS)[number];

/** What the model reports for one field. Source is added by code, never by the model. */
export type ExtractedField<T> = { value: T | null; status: FieldStatus };

/** What the model reported about the latest message. A field it leaves out is "nothing new". */
export type Extraction = { [K in FieldName]?: ExtractedField<RequirementsDoc[K] extends Field<infer T> ? T : never> };

export const INQUIRY_STATUSES = ["NEW", "CLARIFYING", "CONFIGURING", "QUOTE_READY", "REVIEW_REQUIRED"] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export type InquiryEvent =
  /** Code found a blocking field and is asking about it. */
  | { type: "ASK" }
  /** Nothing blocks any more: propose configurations. */
  | { type: "CLEAR" }
  /** A quote the customer can accept was published. */
  | { type: "QUOTE_PUBLISHED" }
  /** The customer, a failure, a cap or the quote gate sends the inquiry to the merchant. */
  | { type: "HAND_OFF" }
  /** The customer changed the request after a quote was ready. */
  | { type: "CUSTOMER_CHANGE" }
  /** The merchant resolved a handed-over inquiry. */
  | { type: "MERCHANT_RESOLVE"; to: "CONFIGURING" | "QUOTE_READY" };

/** Stable codes; other modules match on them. */
export type IntakeErrorCode =
  | "INQUIRY_NOT_FOUND"
  | "MESSAGE_TOO_LONG"
  | "LIMIT_REACHED"
  | "ALREADY_ANSWERED"
  | "MODEL_UNAVAILABLE"
  | "MODEL_OUTPUT_INVALID"
  | "PROPOSAL_STALE"
  | "CONFIGURATION_BLOCKED"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "ILLEGAL_TRANSITION";

export type IntakeResult<T> = { ok: true; value: T } | { ok: false; code: IntakeErrorCode; cause?: string };
