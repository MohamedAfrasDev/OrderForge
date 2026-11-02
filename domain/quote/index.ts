// Public surface of the quote domain. Pure: no Next.js, Supabase, Node or network.
export { canonicalJson } from "./canonical";
export { gateForPublish } from "./gate";
export type { PublishGate } from "./gate";
export { CONDITION_CODES, conditionSchema, draftInputSchema } from "./schemas";
export type { DraftInput } from "./schemas";
export { TERMS_SENTENCE, buildQuoteSnapshot, quoteHash, renderTerms } from "./snapshot";
export type { SnapshotInput } from "./snapshot";
export {
  DEFAULT_VALIDITY_HOURS,
  QUOTE_EVENTS,
  QUOTE_STATUSES,
  expiresAt,
  isExpired,
  isLive,
  isTerminal,
  transition,
} from "./state";
export { QUOTE_SCHEMA_TAG } from "./types";
export type {
  Condition,
  ConditionCode,
  QuoteErrorCode,
  QuoteEvent,
  QuoteResult,
  QuoteSnapshot,
  QuoteStatus,
} from "./types";
