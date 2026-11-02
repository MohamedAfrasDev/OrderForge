import type { Blocker, PricedLine } from "@/domain/catalog/types";
import type { Cents } from "@/lib/money";

export type QuoteStatus = "DRAFT" | "PUBLISHED" | "ACCEPTED" | "SUPERSEDED" | "EXPIRED" | "WITHDRAWN";

export type QuoteEvent = "PUBLISH" | "ACCEPT" | "SUPERSEDE" | "EXPIRE" | "WITHDRAW";

export type ConditionCode =
  | "PRODUCTION_SLOT_CONFIRMATION"
  | "ARTWORK_ACCEPTANCE"
  | "UNSUPPORTED_CUSTOMIZATION"
  | "MERCHANT_APPROVED_CUSTOMIZATION";

/** A term the customer is told about on the quote. `text` is plain text, 1 to 500 characters. */
export type Condition = { code: ConditionCode; text: string };

export const QUOTE_SCHEMA_TAG = "orderforge.quote.v1";

/** The exact object that is hashed. Status and timestamps are deliberately not part of it. */
export type QuoteSnapshot = {
  schema: typeof QUOTE_SCHEMA_TAG;
  merchantId: string;
  inquiryId: string;
  version: number;
  requirementVersionId: string | null;
  boxCount: number;
  perBoxMinor: Cents;
  totalMinor: Cents;
  currency: "USD";
  lines: PricedLine[];
  conditions: Condition[];
};

/** Stable codes; other modules match on them. */
export type QuoteErrorCode =
  | "CONFIGURATION_BLOCKED"
  | "NOT_DRAFT"
  | "NOT_PUBLISHED"
  | "SUPERSEDED"
  | "EXPIRED"
  | "WITHDRAWN"
  | "HASH_MISMATCH"
  | "QUOTE_TAMPERED"
  | "QUOTE_STALE"
  | "MERCHANT_REVIEW_REQUIRED"
  | "MERCHANT_ONLY"
  | "PAYMENT_STARTED"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "ILLEGAL_TRANSITION";

export type QuoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: QuoteErrorCode; blockers?: Blocker[] };
