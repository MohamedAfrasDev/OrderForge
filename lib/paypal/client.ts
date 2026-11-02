// Thin, typed wrapper around the PayPal REST calls OrderForge needs (Orders v2, Payments v2).
// It performs single calls and reports exactly what happened. It never retries, never decides
// payment state, and never logs: the payments module owns state transitions and reconciliation.
import { z } from "zod";
// Relative imports (with extensions) so Node can run this file directly in scripts/paypal-spike.ts.
import type { Cents } from "../money.ts";
import { createTokenProvider } from "./auth.ts";
import {
  SANDBOX_BASE_URL,
  toMinorUnits,
  toPayPalAmount,
  type AuthorizationDetails,
  type AuthorizedOrder,
  type CaptureDetails,
  type CreatedOrder,
  type OrderDetails,
  type PayPalConfig,
  type PayPalResult,
  type VoidedAuthorization,
  type WebhookVerification,
} from "./types.ts";

const RESOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^[\x20-\x7E]{1,10000}$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

function resolveBaseUrl(baseUrl: string | undefined): string {
  const url = new URL(baseUrl ?? SANDBOX_BASE_URL);
  const isSandbox = url.origin === SANDBOX_BASE_URL;
  const isLocalFake = LOCAL_HOSTS.has(url.hostname);
  if (!isSandbox && !isLocalFake) {
    throw new Error("PayPal base URL must be the sandbox host or a local fake server");
  }
  return url.origin;
}

function checkResourceId(id: string): string {
  if (!RESOURCE_ID.test(id)) throw new TypeError("invalid PayPal resource id");
  return id;
}

function assertSingleJsonObject(text: string): void {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("webhook event must be JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("webhook event must be a JSON object");
  }
}

/** The link the payer opens to approve the order. Only an https PayPal address is ever returned. */
function approvalLink(links: Array<{ rel: string; href: string }> | undefined): string | undefined {
  const link = links?.find((l) => l.rel === "payer-action") ?? links?.find((l) => l.rel === "approve");
  if (!link) return undefined;
  try {
    const url = new URL(link.href);
    const paypalHost = url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com");
    return url.protocol === "https:" && paypalHost ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Where PayPal sends the buyer afterwards. https only, or http for a local address while developing. */
function checkReturnUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("invalid return URL");
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new TypeError("return URL must be https");
  return url.toString();
}

function checkRequestId(id: string): string {
  if (!REQUEST_ID.test(id)) throw new TypeError("invalid PayPal-Request-Id");
  return id;
}

const money = z.object({ currency_code: z.string(), value: z.string() });

const orderSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
  purchase_units: z
    .array(
      z.object({
        payments: z
          .object({
            authorizations: z
              .array(
                z.object({
                  id: z.string().min(1),
                  status: z.string().min(1),
                  amount: money.optional(),
                  expiration_time: z.string().optional(),
                }),
              )
              .optional(),
            captures: z.array(z.object({ id: z.string().min(1) })).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

const authorizationSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  amount: money.optional(),
  expiration_time: z.string().optional(),
});

const captureSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  amount: money.optional(),
});

const voidSchema = z.object({ id: z.string().optional(), status: z.string().optional() });

const errorSchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  debug_id: z.string().optional(),
  details: z.array(z.object({ issue: z.string().optional() })).optional(),
});

export function createPayPalClient(config: PayPalConfig) {
  if (config.env !== "sandbox") throw new Error("PayPal env must be 'sandbox'");

  const baseUrl = resolveBaseUrl(config.baseUrl);
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 15_000;
  const tokens = createTokenProvider({
    baseUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    fetch: fetchImpl,
    timeoutMs,
    now: config.now ?? Date.now,
  });

  type Call<T> = {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    /** Pre-serialized JSON, sent as is. Used only where PayPal needs bytes unchanged (webhook verification). */
    rawBody?: string;
    requestId?: string;
    /** Returns the typed data, or null when the 2xx body is not what we expect. */
    read: (json: unknown, status: number) => T | null;
  };

  async function send<T>(call: Call<T>): Promise<PayPalResult<T>> {
    const { method, path, body, rawBody, requestId } = call;

    const token = await tokens.get();
    if (!token.ok) return { kind: "not_sent", reason: token.reason, requestId };

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token.token}`,
      Accept: "application/json",
    };
    if (body !== undefined || rawBody !== undefined) headers["Content-Type"] = "application/json";
    if (requestId) {
      headers["PayPal-Request-Id"] = requestId;
      headers.Prefer = "return=representation";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      // From here the request may have reached PayPal: the outcome is unknown.
      const cause = error instanceof Error && error.name === "AbortError" ? "timeout" : "network";
      return { kind: "timeout", cause, requestId };
    } finally {
      clearTimeout(timer);
    }

    let json: unknown = null;
    let parsedOk = true;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        parsedOk = false;
      }
    }

    if (status < 200 || status >= 300) {
      if (status === 401) tokens.invalidate();
      const error = parsedOk ? errorSchema.safeParse(json) : null;
      const e = error?.success ? error.data : undefined;
      return {
        kind: "provider_error",
        status,
        errorName: e?.name,
        errorMessage: e?.message?.slice(0, 300),
        issues: (e?.details ?? []).flatMap((d) => (d.issue ? [d.issue] : [])),
        debugId: e?.debug_id,
        requestId,
      };
    }

    if (!parsedOk) return { kind: "malformed", status, requestId };
    const data = call.read(json, status);
    return data === null ? { kind: "malformed", status, requestId } : { kind: "ok", data, requestId };
  }

  const amountOf = (a: { currency_code: string; value: string } | undefined) => ({
    amountMinor: a ? (toMinorUnits(a.value) ?? undefined) : undefined,
    currency: a?.currency_code,
  });

  return {
    /** Create an order with intent AUTHORIZE. The amount comes from the caller (the accepted quote), never the browser. */
    /**
     * Create an order with intent AUTHORIZE. When the buyer approves through a link (not the PayPal popup),
     * PayPal needs a return URL or the buyer lands on an error page, so pass `returnUrl` for that flow.
     */
    createOrder(input: {
      amount: Cents;
      referenceId: string;
      requestId: string;
      returnUrl?: string;
      cancelUrl?: string;
    }): Promise<PayPalResult<CreatedOrder>> {
      if (!(input.amount > 0)) throw new RangeError("order amount must be positive");
      if (input.referenceId.length < 1 || input.referenceId.length > 256) throw new TypeError("invalid reference id");
      const returnUrl = input.returnUrl === undefined ? undefined : checkReturnUrl(input.returnUrl);
      const cancelUrl = input.cancelUrl === undefined ? returnUrl : checkReturnUrl(input.cancelUrl);
      return send({
        method: "POST",
        path: "/v2/checkout/orders",
        requestId: checkRequestId(input.requestId),
        body: {
          intent: "AUTHORIZE",
          purchase_units: [
            {
              reference_id: input.referenceId,
              amount: { currency_code: "USD", value: toPayPalAmount(input.amount) },
            },
          ],
          ...(returnUrl
            ? {
                payment_source: {
                  paypal: {
                    experience_context: {
                      return_url: returnUrl,
                      cancel_url: cancelUrl,
                      user_action: "CONTINUE",
                      shipping_preference: "NO_SHIPPING",
                    },
                  },
                },
              }
            : {}),
        },
        read: (json) => {
          const r = orderSchema.safeParse(json);
          return r.success ? { id: r.data.id, status: r.data.status, approveUrl: approvalLink(r.data.links) } : null;
        },
      });
    },

    /** Authorize an order the payer has approved. Returns the authorization id from purchase_units[0].payments.authorizations[0]. */
    authorizeOrder(orderId: string, requestId: string): Promise<PayPalResult<AuthorizedOrder>> {
      return send({
        method: "POST",
        path: `/v2/checkout/orders/${checkResourceId(orderId)}/authorize`,
        requestId: checkRequestId(requestId),
        body: {},
        read: (json) => {
          const r = orderSchema.safeParse(json);
          if (!r.success) return null;
          const auth = r.data.purchase_units?.[0]?.payments?.authorizations?.[0];
          if (!auth?.amount) return null;
          const amountMinor = toMinorUnits(auth.amount.value);
          if (amountMinor === null) return null;
          return {
            orderId: r.data.id,
            orderStatus: r.data.status,
            authorizationId: auth.id,
            authorizationStatus: auth.status,
            amountMinor,
            currency: auth.amount.currency_code,
            expirationTime: auth.expiration_time,
          };
        },
      });
    },

    /** Capture an authorization. Omit `amount` to capture the full authorized amount. */
    captureAuthorization(
      authorizationId: string,
      requestId: string,
      options: { amount?: Cents; finalCapture?: boolean } = {},
    ): Promise<PayPalResult<CaptureDetails>> {
      const body: Record<string, unknown> = {};
      if (options.amount !== undefined) {
        if (!(options.amount > 0)) throw new RangeError("capture amount must be positive");
        body.amount = { currency_code: "USD", value: toPayPalAmount(options.amount) };
      }
      if (options.finalCapture !== undefined) body.final_capture = options.finalCapture;

      return send({
        method: "POST",
        path: `/v2/payments/authorizations/${checkResourceId(authorizationId)}/capture`,
        requestId: checkRequestId(requestId),
        body,
        read: (json) => {
          const r = captureSchema.safeParse(json);
          return r.success ? { captureId: r.data.id, status: r.data.status, ...amountOf(r.data.amount) } : null;
        },
      });
    },

    /** Void an uncaptured authorization. A 204 (no body) is success. */
    voidAuthorization(authorizationId: string, requestId: string): Promise<PayPalResult<VoidedAuthorization>> {
      const id = checkResourceId(authorizationId);
      return send({
        method: "POST",
        path: `/v2/payments/authorizations/${id}/void`,
        requestId: checkRequestId(requestId),
        read: (json) => {
          if (json === null) return { authorizationId: id, status: "VOIDED" as const };
          const r = voidSchema.safeParse(json);
          if (!r.success) return null;
          // A 2xx that names some other status contradicts "voided": do not trust it.
          if (r.data.status !== undefined && r.data.status !== "VOIDED") return null;
          return { authorizationId: id, status: "VOIDED" as const };
        },
      });
    },

    /**
     * Ask PayPal whether a webhook delivery is genuine. `rawEvent` must be the request body text exactly
     * as received: PayPal requires it back with no change of formatting, so it is embedded verbatim.
     * It must be a single JSON object, which also stops a crafted body from adding fields to this request.
     */
    verifyWebhookSignature(input: WebhookVerification): Promise<PayPalResult<{ verified: boolean }>> {
      assertSingleJsonObject(input.rawEvent);
      const field = (name: string, value: string) => `${JSON.stringify(name)}:${JSON.stringify(value)}`;
      const rawBody =
        `{${field("auth_algo", input.authAlgo)},${field("cert_url", input.certUrl)},` +
        `${field("transmission_id", input.transmissionId)},${field("transmission_sig", input.transmissionSig)},` +
        `${field("transmission_time", input.transmissionTime)},${field("webhook_id", input.webhookId)},` +
        `"webhook_event":${input.rawEvent}}`;
      return send({
        method: "POST",
        path: "/v1/notifications/verify-webhook-signature",
        rawBody,
        read: (json) => {
          const r = z.object({ verification_status: z.string().optional() }).safeParse(json);
          // Only the exact documented success value counts; anything else is not verified.
          return r.success ? { verified: r.data.verification_status === "SUCCESS" } : null;
        },
      });
    },

    getOrder(orderId: string): Promise<PayPalResult<OrderDetails>> {
      return send({
        method: "GET",
        path: `/v2/checkout/orders/${checkResourceId(orderId)}`,
        read: (json) => {
          const r = orderSchema.safeParse(json);
          if (!r.success) return null;
          const payments = r.data.purchase_units?.[0]?.payments;
          return {
            id: r.data.id,
            status: r.data.status,
            authorizationId: payments?.authorizations?.[0]?.id,
            captureId: payments?.captures?.[0]?.id,
          };
        },
      });
    },

    getAuthorization(authorizationId: string): Promise<PayPalResult<AuthorizationDetails>> {
      return send({
        method: "GET",
        path: `/v2/payments/authorizations/${checkResourceId(authorizationId)}`,
        read: (json) => {
          const r = authorizationSchema.safeParse(json);
          return r.success
            ? { id: r.data.id, status: r.data.status, expirationTime: r.data.expiration_time, ...amountOf(r.data.amount) }
            : null;
        },
      });
    },

    getCapture(captureId: string): Promise<PayPalResult<CaptureDetails>> {
      return send({
        method: "GET",
        path: `/v2/payments/captures/${checkResourceId(captureId)}`,
        read: (json) => {
          const r = captureSchema.safeParse(json);
          return r.success ? { captureId: r.data.id, status: r.data.status, ...amountOf(r.data.amount) } : null;
        },
      });
    },
  };
}

export type PayPalClient = ReturnType<typeof createPayPalClient>;
