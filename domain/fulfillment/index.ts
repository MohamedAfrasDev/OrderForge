// Public surface of the fulfillment domain. Pure: no Next.js, Supabase, Node, PayPal or network.
export { customerStatusOf } from "./customer-status";
export { allowedMoves, transition } from "./state";
export { JOB_STATUSES, WORKSHEET_SCHEMA_TAG } from "./types";
export type {
  CustomerStatus,
  FulfillmentErrorCode,
  FulfillmentResult,
  JobStatus,
  TransitionContext,
  Worksheet,
  WorksheetFacts,
} from "./types";
export { buildWorksheet, worksheetSchema } from "./worksheet";
