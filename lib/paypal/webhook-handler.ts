import type { PayPalResult, WebhookVerification } from "@/lib/paypal/types";
import { parseEvent, readSignatureHeaders } from "@/lib/paypal/webhook";

export type EvidenceLabel = "mocked" | "replayed" | "real-sandbox";

export type PaymentEventRow = {
  provider_event_id: string;
  event_type: string;
  source: "webhook";
  evidence_label: EvidenceLabel;
  payload: Record<string, string | number>;
};

export type WebhookDeps = {
  webhookId: string;
  verifySignature: (input: WebhookVerification) => Promise<PayPalResult<{ verified: boolean }>>;
  /** Inserts the event; "duplicate" when its provider event id was already stored. Throws on any other failure. */
  record: (row: PaymentEventRow) => Promise<"recorded" | "duplicate">;
  /**
   * Acts on a stored event (payments finds the attempt and reconciles it by asking PayPal). Called for a new event and
   * for a redelivery, and must do nothing the second time once it has succeeded. A throw answers 500 so PayPal retries.
   */
  apply?: (providerEventId: string) => Promise<unknown>;
  /** What kind of evidence a stored event is. Production wiring uses "real-sandbox": PayPal itself vouched for it. */
  evidenceLabel: EvidenceLabel;
  maxBodyBytes?: number;
};

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

const reply = (body: Record<string, string>, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Status codes are chosen for PayPal's retry behaviour (it retries non-2xx up to 25 times over 3 days):
 *  - 200: recorded, or already recorded (duplicate). No second effect.
 *  - 400/413: the delivery is not genuine or not readable. Retrying will not help.
 *  - 503/500: we could not decide or could not store. Please retry.
 */
export async function handlePayPalWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const maxBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return reply({ error: "too_large" }, 413);

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > maxBytes) return reply({ error: "too_large" }, 413);

  const headers = readSignatureHeaders(request.headers);
  if (!headers) return reply({ error: "invalid_signature" }, 400);

  const event = parseEvent(rawBody);
  if (!event) return reply({ error: "invalid_body" }, 400);

  // Only PayPal can say whether the signature is real.
  const verification = await deps.verifySignature({ ...headers, webhookId: deps.webhookId, rawEvent: rawBody });
  if (verification.kind !== "ok") return reply({ error: "verification_unavailable" }, 503);
  if (!verification.data.verified) return reply({ error: "invalid_signature" }, 400);

  try {
    const outcome = await deps.record({
      provider_event_id: event.id,
      event_type: event.eventType,
      source: "webhook",
      evidence_label: deps.evidenceLabel,
      payload: event.summary,
    });
    if (deps.apply) {
      try {
        await deps.apply(event.id);
      } catch {
        // Stored but not acted on: the event stays unprocessed, so the redelivery PayPal sends will act on it.
        return reply({ error: "processing_failed" }, 500);
      }
    }
    return reply({ status: outcome }, 200);
  } catch {
    return reply({ error: "storage_failed" }, 500);
  }
}
