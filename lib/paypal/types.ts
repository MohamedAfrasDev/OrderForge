import { cents, type Cents } from "../money.ts";

export const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

export type PayPalConfig = {
  /** Only "sandbox" is accepted. The type is wider so a bad value fails loudly at runtime too. */
  env: "sandbox";
  clientId: string;
  clientSecret: string;
  /** Sandbox host or a local fake server (127.0.0.1 / localhost). Anything else is refused. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request timeout, token requests included. Default 15 s. */
  timeoutMs?: number;
  now?: () => number;
};

/**
 * Outcome of one PayPal call. The kinds matter to the payment state machine:
 *  - ok:             PayPal answered 2xx and the body was what we expected.
 *  - provider_error: PayPal answered with an error status. Definitive for that call.
 *  - not_sent:       We could not even get an access token, so the operation never left. Safe to retry.
 *  - timeout:        No usable answer after the request may have been sent. The outcome is UNKNOWN:
 *                    query PayPal before any retry (OUTCOME_UNKNOWN).
 *  - malformed:      PayPal answered 2xx but the body was not readable as expected. The operation may
 *                    have taken effect, so treat it like an unknown outcome and reconcile.
 * This module never retries on its own.
 */
export type PayPalResult<T> =
  | { kind: "ok"; data: T; requestId?: string }
  | {
      kind: "provider_error";
      status: number;
      errorName?: string;
      errorMessage?: string;
      issues: string[];
      debugId?: string;
      requestId?: string;
    }
  | { kind: "not_sent"; reason: "auth_failed" | "timeout" | "network"; requestId?: string }
  | { kind: "timeout"; cause: "timeout" | "network"; requestId?: string }
  | { kind: "malformed"; status: number; requestId?: string };

export type CreatedOrder = { id: string; status: string; approveUrl?: string };

export type AuthorizedOrder = {
  orderId: string;
  orderStatus: string;
  authorizationId: string;
  authorizationStatus: string;
  amountMinor: Cents;
  /** As PayPal reported it, not assumed to be USD: another currency is a financial exception for payments to flag. */
  currency: string;
  expirationTime?: string;
};

export type OrderDetails = {
  id: string;
  status: string;
  authorizationId?: string;
  captureId?: string;
  /** The merchant the order pays, when PayPal reports it. */
  payeeMerchantId?: string;
};

export type AuthorizationDetails = {
  id: string;
  status: string;
  amountMinor?: Cents;
  currency?: string;
  expirationTime?: string;
};

export type CaptureDetails = {
  captureId: string;
  status: string;
  amountMinor?: Cents;
  currency?: string;
};

export type VoidedAuthorization = { authorizationId: string; status: "VOIDED" };

export type WebhookVerification = {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  webhookId: string;
  /** The request body text exactly as received. */
  rawEvent: string;
};

/** Integer cents to PayPal's decimal string, with no floating point: 108000 -> "1080.00". */
export function toPayPalAmount(amount: Cents): string {
  if (amount < 0) throw new RangeError("amount must not be negative");
  const whole = Math.floor(amount / 100);
  const fraction = String(amount % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

/** PayPal's decimal string back to integer cents. Strict: exactly two decimals, digits only. */
export function toMinorUnits(value: string): Cents | null {
  const match = /^(\d+)\.(\d{2})$/.exec(value);
  if (!match) return null;
  const total = Number(match[1]) * 100 + Number(match[2]);
  return Number.isSafeInteger(total) ? cents(total) : null;
}
