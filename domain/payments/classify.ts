import type { Classification, Operation } from "./types";

/** The shape of the PayPal client's results that matters here. The client's own `PayPalResult` is assignable to it. */
export type ClassifiableResult =
  | { kind: "ok" }
  | { kind: "provider_error"; status: number }
  | { kind: "not_sent" }
  | { kind: "timeout" }
  | { kind: "malformed" };

/**
 * How a PayPal answer must be treated:
 *  - DONE: PayPal answered and the body was what we expected.
 *  - DEFINITIVE_FAILURE: PayPal refused this call (4xx). Nothing happened.
 *  - NOT_SENT: the request never reached PayPal's processing (no access token, or rate limited). Safe to retry.
 *  - UNKNOWN: the request may have been processed (timeout, an unreadable 2xx body, a server error, 408). Query PayPal
 *    before anything is retried.
 * Creating an order moves no money and PayPal de-duplicates it by request id, so an uncertain create is safe to repeat.
 */
export function classifyPayPal(result: ClassifiableResult, operation: Operation): Classification {
  switch (result.kind) {
    case "ok":
      return "DONE";
    case "not_sent":
      return "NOT_SENT";
    case "timeout":
    case "malformed":
      return operation === "create" ? "NOT_SENT" : "UNKNOWN";
    case "provider_error": {
      if (result.status === 429) return "NOT_SENT";
      if (result.status === 408 || result.status >= 500) return operation === "create" ? "NOT_SENT" : "UNKNOWN";
      return "DEFINITIVE_FAILURE";
    }
  }
}
