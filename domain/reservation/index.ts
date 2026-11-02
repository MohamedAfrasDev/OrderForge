// Public surface of the reservation domain. Pure: no Next.js, Supabase, Node or network.
export { stockInvariant } from "./invariant";
export type { Discrepancy, InvariantOptions, StockRow } from "./invariant";
export { requiredQuantities } from "./quantities";
export {
  LIVE_STATES,
  OPERATIONS,
  RESERVATION_STATES,
  SETTLE_OUTCOMES,
  isLive,
  outcomeOperation,
  stockEffect,
  transition,
} from "./state";
export type {
  Operation,
  ProductQuantity,
  ReleaseReason,
  ReservationErrorCode,
  ReservationEvent,
  ReservationResult,
  ReservationState,
  SettleOutcome,
  Shortage,
  StockEffect,
  TransitionContext,
} from "./types";
