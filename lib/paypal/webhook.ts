// Pure helpers for PayPal webhook deliveries: header checks and event parsing.
// Nothing here trusts the delivery. Trust comes only from PayPal confirming the signature.
import { z } from "zod";
import { toMinorUnits } from "@/lib/paypal/types";

/** The only signature algorithm PayPal documents for webhooks. Anything else fails closed. */
const ACCEPTED_AUTH_ALGO = "SHA256withRSA";
const HEADER_VALUE = /^[\x21-\x7E]{1,512}$/;

export type SignatureHeaders = {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
};

function isPayPalCertUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}

/** Null when any signature header is missing or implausible. */
export function readSignatureHeaders(headers: Headers): SignatureHeaders | null {
  const authAlgo = headers.get("paypal-auth-algo");
  const certUrl = headers.get("paypal-cert-url");
  const transmissionId = headers.get("paypal-transmission-id");
  const transmissionSig = headers.get("paypal-transmission-sig");
  const transmissionTime = headers.get("paypal-transmission-time");
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) return null;

  if (authAlgo !== ACCEPTED_AUTH_ALGO) return null;
  if (!isPayPalCertUrl(certUrl)) return null;
  if (!HEADER_VALUE.test(transmissionId) || !HEADER_VALUE.test(transmissionSig)) return null;
  if (Number.isNaN(Date.parse(transmissionTime))) return null;

  return { authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime };
}

const eventSchema = z.object({
  id: z.string().min(1).max(128),
  event_type: z.string().min(1).max(128),
  resource_type: z.string().max(64).optional(),
  create_time: z.string().max(64).optional(),
  resource: z.record(z.string(), z.unknown()).optional(),
});

export type ParsedEvent = {
  id: string;
  eventType: string;
  /** A small allowlisted summary. The full event (which can carry payer details) is never stored. */
  summary: Record<string, string | number>;
};

const short = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, 200) : undefined;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Null unless the text is one JSON object with a usable event id and type. */
export function parseEvent(rawBody: string): ParsedEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success) return null;
  const { id, event_type, resource_type, create_time, resource = {} } = parsed.data;

  const amount = record(resource.amount);
  const amountMinor = typeof amount?.value === "string" ? toMinorUnits(amount.value) : null;
  const related = record(record(resource.supplementary_data)?.related_ids);

  const summary: Record<string, string | number> = {};
  const put = (key: string, value: string | number | undefined | null) => {
    if (value !== undefined && value !== null) summary[key] = value;
  };
  put("resource_type", short(resource_type));
  put("resource_id", short(resource.id));
  put("resource_status", short(resource.status));
  put("amount_minor", amountMinor);
  put("currency", short(amount?.currency_code));
  put("order_id", short(related?.order_id));
  put("authorization_id", short(related?.authorization_id));
  put("create_time", short(create_time));

  return { id, eventType: event_type, summary };
}
