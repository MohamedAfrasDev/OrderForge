// Public surface of the payments domain. Pure: no Next.js, Supabase, Node, PayPal or network.
export { classifyPayPal } from "./classify";
export type { ClassifiableResult } from "./classify";
export { requestId } from "./request-id";
export {
  ATTEMPT_STATES,
  BEGIN_OPERATIONS,
  IN_FLIGHT_STATES,
  PAIRED_RESERVATION_STATES,
  SETTLE_OUTCOMES,
  TERMINAL_STATES,
  inFlightOperationOf,
  isActive,
  transition,
} from "./state";
export type {
  AttemptEvent,
  AttemptState,
  BeginOperation,
  Classification,
  ExceptionReason,
  Operation,
  PaymentErrorCode,
  PaymentResult,
  SettleOutcome,
  TransitionContext,
} from "./types";
export { expectedPayment, unconfirmedConditions, verifyAuthorization, verifyCapture } from "./verify";
export type { AttemptFacts, ProviderAuthorized, ProviderCapture, ProviderOrder, Verification } from "./verify";
