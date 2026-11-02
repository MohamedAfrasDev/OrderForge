import type { Operation } from "./types";

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATIONS: readonly Operation[] = ["create", "authorize", "capture", "void"];

/**
 * The `PayPal-Request-Id` for one operation of one attempt: stable, so a repeat of the same call can never do the
 * operation twice, and different per operation, so one operation is never mistaken for another.
 */
export function requestId(attemptId: string, operation: Operation): string {
  if (!ATTEMPT_ID.test(attemptId)) throw new TypeError("requestId: attempt id must be a UUID");
  if (!OPERATIONS.includes(operation)) throw new TypeError("requestId: unknown operation");
  return `of-${attemptId}-${operation}`;
}
