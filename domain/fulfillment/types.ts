export const JOB_STATUSES = ["QUEUED", "PREPARING", "READY_FOR_PICKUP", "COLLECTED", "ON_HOLD"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** What a transition needs to know about the stored job. */
export type TransitionContext = {
  /** The status the job was in before it was put on hold. Needed to resume; ignored everywhere else. */
  heldFrom?: JobStatus | null;
};

/** Stable codes; other modules match on them. */
export type FulfillmentErrorCode = "NOT_PAID" | "QUOTE_NOT_ACCEPTED" | "NOT_FOUND" | "ILLEGAL_TRANSITION" | "NOTE_REQUIRED" | "INVALID_INPUT";

export type FulfillmentResult<T> = { ok: true; value: T } | { ok: false; code: FulfillmentErrorCode; cause?: string };

/** The four words a customer sees. */
export type CustomerStatus = "PREPARING" | "READY" | "COLLECTED" | "DELAYED";

export const WORKSHEET_SCHEMA_TAG = "orderforge.worksheet.v1" as const;

export type Worksheet = {
  schema: typeof WORKSHEET_SCHEMA_TAG;
  quote: { version: number; hash: string };
  purchaseId: string;
  inquiryId: string;
  boxCount: number;
  /** What goes into each box, slot by slot. */
  perBox: Array<{ slotId: string; sku: string; name: string; quantityPerBox: number }>;
  /** What to pick in total: quantity per box times boxes, summed per SKU, in SKU order. */
  pick: Array<{ sku: string; name: string; quantity: number }>;
  conditions: Array<{ code: string; text: string; confirmed: boolean }>;
  fulfilment: { method: "customer_pickup" };
  productionLeadDays: number;
  /** YYYY-MM-DD (UTC): the day the job was created plus the lead days. */
  readyBy: string;
  paid: { totalMinor: number; currency: "USD" };
};

/** Facts the worksheet freezes besides the accepted snapshot. The time is passed in; nothing here reads a clock. */
export type WorksheetFacts = {
  purchaseId: string;
  quoteHash: string;
  fulfilmentMethod: "customer_pickup";
  productionLeadDays: number;
  /** ISO timestamp of the job's creation. */
  createdAt: string;
  /** Codes of the conditions the merchant confirmed when accepting. */
  confirmedConditions: readonly string[];
};
