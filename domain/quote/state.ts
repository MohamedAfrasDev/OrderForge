import type { QuoteEvent, QuoteStatus } from "./types";

export const QUOTE_STATUSES: readonly QuoteStatus[] = ["DRAFT", "PUBLISHED", "ACCEPTED", "SUPERSEDED", "EXPIRED", "WITHDRAWN"];
export const QUOTE_EVENTS: readonly QuoteEvent[] = ["PUBLISH", "ACCEPT", "SUPERSEDE", "EXPIRE", "WITHDRAW"];

/** The only quote state machine. The database trigger in migration 0005 enforces the same table. */
const TABLE: Record<QuoteStatus, Partial<Record<QuoteEvent, QuoteStatus>>> = {
  DRAFT: { PUBLISH: "PUBLISHED", WITHDRAW: "WITHDRAWN" },
  PUBLISHED: { ACCEPT: "ACCEPTED", SUPERSEDE: "SUPERSEDED", EXPIRE: "EXPIRED", WITHDRAW: "WITHDRAWN" },
  ACCEPTED: { SUPERSEDE: "SUPERSEDED" },
  SUPERSEDED: {},
  EXPIRED: {},
  WITHDRAWN: {},
};

export function transition(from: QuoteStatus, event: QuoteEvent): QuoteStatus | { error: "ILLEGAL_TRANSITION" } {
  return TABLE[from][event] ?? { error: "ILLEGAL_TRANSITION" };
}

/** At most one live quote per inquiry (a partial unique index enforces it). */
export const isLive = (s: QuoteStatus): boolean => s === "PUBLISHED" || s === "ACCEPTED";

export const isTerminal = (s: QuoteStatus): boolean => s === "SUPERSEDED" || s === "EXPIRED" || s === "WITHDRAWN";

/** Default for the merchant rule `quote_validity_hours`. */
export const DEFAULT_VALIDITY_HOURS = 72;

function instant(value: string, what: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new RangeError(`${what} is not a valid timestamp`);
  return ms;
}

function assertHours(hours: number): void {
  if (!Number.isInteger(hours) || hours < 1) throw new RangeError("validityHours must be a positive integer");
}

/** ISO timestamp (UTC) of the last instant at which a published quote can still be accepted. */
export function expiresAt(publishedAt: string, validityHours: number): string {
  assertHours(validityHours);
  return new Date(instant(publishedAt, "publishedAt") + validityHours * 3_600_000).toISOString();
}

/** Acceptable through the boundary itself; expired from the next millisecond. `now` is passed in, never read. */
export function isExpired(publishedAt: string, validityHours: number, now: string): boolean {
  assertHours(validityHours);
  return instant(now, "now") > instant(publishedAt, "publishedAt") + validityHours * 3_600_000;
}
