// Evidence labels in this file: MOCKED (PayPal's verification API and the database are replaced)
// and REPLAYED (the same signed delivery is sent more than once). No real PayPal traffic.
import { describe, expect, it, vi } from "vitest";
import { createPayPalClient } from "@/lib/paypal/client";
import type { PayPalResult } from "@/lib/paypal/types";
import { handlePayPalWebhook, type WebhookDeps } from "@/lib/paypal/webhook-handler";

const WEBHOOK_ID = "WH-TEST-0001";

const SIGNED_HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42",
  "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "paypal-transmission-sig": "lmI95Jx3Y9nhR5SJWlHVIWpg4AgWTjkPmLNfLvMbFBI=",
  "paypal-transmission-time": "2026-11-05T09:30:00Z",
};

// Deliberately awkward formatting: odd spacing, key order, unicode. It must reach PayPal untouched.
const EVENT_TEXT =
  '{ "id":"WH-EVT-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource_type":"capture",' +
  '"create_time":"2026-11-05T09:29:58Z","resource":{"id":"CAP-1","status":"COMPLETED",' +
  '"amount":{"currency_code":"USD","value":"1080.00"},"payer_note":"café ☕",' +
  '"supplementary_data":{"related_ids":{"order_id":"ORDER1","authorization_id":"AUTH-1"}},' +
  '"payer":{"email_address":"buyer@example.com"}} }';

function request(body: string, headers: Record<string, string> = SIGNED_HEADERS, init: RequestInit = {}) {
  return new Request("http://localhost/api/webhooks/paypal", { method: "POST", body, headers, ...init });
}

type StoredRow = Parameters<WebhookDeps["record"]>[0];

function makeDeps(overrides: Partial<WebhookDeps> = {}) {
  const store = new Map<string, StoredRow>();
  const verifySignature = vi.fn(
    async (): Promise<PayPalResult<{ verified: boolean }>> => ({ kind: "ok", data: { verified: true } }),
  );
  const record = vi.fn(async (row: StoredRow) => {
    // Emulates the UNIQUE constraint on payment_events.provider_event_id.
    if (store.has(row.provider_event_id)) return "duplicate" as const;
    store.set(row.provider_event_id, row);
    return "recorded" as const;
  });
  const deps: WebhookDeps = { webhookId: WEBHOOK_ID, verifySignature, record, evidenceLabel: "mocked", ...overrides };
  return { deps, store, verifySignature, record };
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("a genuine delivery", () => {
  it("is verified, recorded once, and acknowledged", async () => {
    const { deps, store, verifySignature } = makeDeps();
    const response = await handlePayPalWebhook(request(EVENT_TEXT), deps);

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ status: "recorded" });
    expect(verifySignature).toHaveBeenCalledOnce();
    expect(store.size).toBe(1);
  });

  it("sends PayPal the headers, the configured webhook id and the event text exactly as received", async () => {
    const { deps, verifySignature } = makeDeps();
    await handlePayPalWebhook(request(EVENT_TEXT), deps);

    expect(verifySignature).toHaveBeenCalledWith({
      authAlgo: "SHA256withRSA",
      certUrl: SIGNED_HEADERS["paypal-cert-url"],
      transmissionId: SIGNED_HEADERS["paypal-transmission-id"],
      transmissionSig: SIGNED_HEADERS["paypal-transmission-sig"],
      transmissionTime: SIGNED_HEADERS["paypal-transmission-time"],
      webhookId: WEBHOOK_ID,
      rawEvent: EVENT_TEXT,
    });
  });

  it("stores a minimal summary keyed by the provider event id, without payer details", async () => {
    const { deps, store } = makeDeps();
    await handlePayPalWebhook(request(EVENT_TEXT), deps);

    const row = store.get("WH-EVT-1")!;
    expect(row).toMatchObject({
      provider_event_id: "WH-EVT-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      source: "webhook",
      evidence_label: "mocked",
    });
    expect(row.payload).toEqual({
      resource_type: "capture",
      resource_id: "CAP-1",
      resource_status: "COMPLETED",
      amount_minor: 108000,
      currency: "USD",
      order_id: "ORDER1",
      authorization_id: "AUTH-1",
      create_time: "2026-11-05T09:29:58Z",
    });
    expect(JSON.stringify(row)).not.toContain("buyer@example.com");
    expect(JSON.stringify(row)).not.toContain("café");
  });
});

describe("replayed deliveries (PayPal retries until it gets a 2xx)", () => {
  it("acknowledges a duplicate event id with no second effect", async () => {
    const { deps, store, record } = makeDeps();
    const first = await handlePayPalWebhook(request(EVENT_TEXT), deps);
    const second = await handlePayPalWebhook(request(EVENT_TEXT), deps);
    const third = await handlePayPalWebhook(request(EVENT_TEXT), deps);

    expect(first.status).toBe(200);
    expect(await json(first)).toEqual({ status: "recorded" });
    for (const replay of [second, third]) {
      expect(replay.status).toBe(200);
      expect(await json(replay)).toEqual({ status: "duplicate" });
    }
    expect(record).toHaveBeenCalledTimes(3);
    expect(store.size).toBe(1);
  });
});

describe("forged or malformed deliveries", () => {
  it("rejects a delivery PayPal says is not genuine, and stores nothing", async () => {
    const { deps, store } = makeDeps({
      verifySignature: vi.fn(async () => ({ kind: "ok", data: { verified: false } }) as const),
    });
    const response = await handlePayPalWebhook(request(EVENT_TEXT), deps);
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "invalid_signature" });
    expect(store.size).toBe(0);
  });

  it.each(Object.keys(SIGNED_HEADERS))("rejects a delivery missing %s without calling PayPal", async (name) => {
    const { deps, verifySignature, store } = makeDeps();
    const headers = { ...SIGNED_HEADERS } as Record<string, string>;
    delete headers[name];
    const response = await handlePayPalWebhook(request(EVENT_TEXT, headers), deps);
    expect(response.status).toBe(400);
    expect(verifySignature).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("rejects an unsigned request with no headers at all", async () => {
    const { deps, verifySignature } = makeDeps();
    const response = await handlePayPalWebhook(request(EVENT_TEXT, {}), deps);
    expect(response.status).toBe(400);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it("rejects an unexpected signature algorithm", async () => {
    const { deps, verifySignature } = makeDeps();
    const response = await handlePayPalWebhook(
      request(EVENT_TEXT, { ...SIGNED_HEADERS, "paypal-auth-algo": "none" }),
      deps,
    );
    expect(response.status).toBe(400);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it.each([
    "http://api.sandbox.paypal.com/v1/notifications/certs/CERT",
    "https://evil.example.com/v1/notifications/certs/CERT",
    "https://paypal.com.evil.example/certs/CERT",
    "not a url",
  ])("rejects a certificate URL that is not an https PayPal host: %s", async (certUrl) => {
    const { deps, verifySignature } = makeDeps();
    const response = await handlePayPalWebhook(
      request(EVENT_TEXT, { ...SIGNED_HEADERS, "paypal-cert-url": certUrl }),
      deps,
    );
    expect(response.status).toBe(400);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it("rejects a transmission time that is not a date", async () => {
    const { deps, verifySignature } = makeDeps();
    const response = await handlePayPalWebhook(
      request(EVENT_TEXT, { ...SIGNED_HEADERS, "paypal-transmission-time": "yesterday-ish" }),
      deps,
    );
    expect(response.status).toBe(400);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it.each([
    ["not json", "this is not json"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON string", '"hello"'],
    ["JSON null", "null"],
    ["an empty body", ""],
    ["trailing fields that could be smuggled into the verification request", '{"id":"E","event_type":"X","resource":{}},"webhook_id":"attacker"'],
    ["no event id", '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{}}'],
    ["no event type", '{"id":"E","resource":{}}'],
    ["an oversized event id", `{"id":"${"E".repeat(200)}","event_type":"X","resource":{}}`],
  ])("rejects %s without calling PayPal", async (_label, body) => {
    const { deps, verifySignature, store } = makeDeps();
    const response = await handlePayPalWebhook(request(body), deps);
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "invalid_body" });
    expect(verifySignature).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("rejects an oversized body", async () => {
    const { deps, verifySignature } = makeDeps({ maxBodyBytes: 1024 });
    const huge = JSON.stringify({ id: "E", event_type: "X", resource: { blob: "x".repeat(5000) } });
    const response = await handlePayPalWebhook(request(huge), deps);
    expect(response.status).toBe(413);
    expect(verifySignature).not.toHaveBeenCalled();
  });
});

describe("when we cannot tell whether a delivery is genuine", () => {
  const unavailable: Array<[string, PayPalResult<{ verified: boolean }>]> = [
    ["a timeout", { kind: "timeout", cause: "timeout" }],
    ["a network error", { kind: "timeout", cause: "network" }],
    ["no access token", { kind: "not_sent", reason: "auth_failed" }],
    ["a PayPal server error", { kind: "provider_error", status: 500, issues: [] }],
    ["an unreadable answer", { kind: "malformed", status: 200 }],
  ];

  it.each(unavailable)("answers 503 so PayPal retries, and stores nothing, after %s", async (_label, result) => {
    const { deps, store } = makeDeps({ verifySignature: vi.fn(async () => result) });
    const response = await handlePayPalWebhook(request(EVENT_TEXT), deps);
    expect(response.status).toBe(503);
    expect(store.size).toBe(0);
  });

  it("answers 500 so PayPal retries when the database write fails", async () => {
    const { deps } = makeDeps({
      record: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const response = await handlePayPalWebhook(request(EVENT_TEXT), deps);
    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({ error: "storage_failed" });
  });
});

describe("PayPal client: verifyWebhookSignature", () => {
  function clientWith(answer: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok-123456", expires_in: 32400 }), { status: 200 });
      }
      return answer();
    });
    const client = createPayPalClient({
      env: "sandbox",
      clientId: "id",
      clientSecret: "secret",
      fetch: fn as unknown as typeof fetch,
    });
    return { client, calls };
  }

  const input = {
    authAlgo: "SHA256withRSA",
    certUrl: SIGNED_HEADERS["paypal-cert-url"],
    transmissionId: SIGNED_HEADERS["paypal-transmission-id"],
    transmissionSig: SIGNED_HEADERS["paypal-transmission-sig"],
    transmissionTime: SIGNED_HEADERS["paypal-transmission-time"],
    webhookId: WEBHOOK_ID,
    rawEvent: EVENT_TEXT,
  };

  it("posts the seven required fields and embeds the event text byte for byte", async () => {
    const { client, calls } = clientWith(() => new Response(JSON.stringify({ verification_status: "SUCCESS" })));
    const result = await client.verifyWebhookSignature(input);

    const call = calls.find((c) => c.url.endsWith("/v1/notifications/verify-webhook-signature"))!;
    expect(call.init.method).toBe("POST");
    const body = String(call.init.body);
    // The event is embedded verbatim, not re-serialized.
    expect(body).toContain(`"webhook_event":${EVENT_TEXT}`);
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({
      auth_algo: "SHA256withRSA",
      cert_url: input.certUrl,
      transmission_id: input.transmissionId,
      transmission_sig: input.transmissionSig,
      transmission_time: input.transmissionTime,
      webhook_id: WEBHOOK_ID,
    });
    expect(parsed.webhook_event.id).toBe("WH-EVT-1");
    expect(result).toEqual({ kind: "ok", data: { verified: true }, requestId: undefined });
  });

  it("is verified only for exactly SUCCESS", async () => {
    for (const status of ["FAILURE", "success", "", "OK", undefined]) {
      const { client } = clientWith(() => new Response(JSON.stringify({ verification_status: status })));
      expect(await client.verifyWebhookSignature(input)).toMatchObject({ kind: "ok", data: { verified: false } });
    }
  });

  it("refuses to embed an event that is not a single JSON object", () => {
    const { client } = clientWith(() => new Response("{}"));
    expect(() => client.verifyWebhookSignature({ ...input, rawEvent: '{"a":1},"webhook_id":"attacker"' })).toThrow();
    expect(() => client.verifyWebhookSignature({ ...input, rawEvent: "[1]" })).toThrow();
    expect(() => client.verifyWebhookSignature({ ...input, rawEvent: "nope" })).toThrow();
  });

  it("does not send an idempotency key (it is not a state-changing call)", async () => {
    const { client, calls } = clientWith(() => new Response(JSON.stringify({ verification_status: "SUCCESS" })));
    await client.verifyWebhookSignature(input);
    const call = calls.find((c) => c.url.endsWith("/verify-webhook-signature"))!;
    expect((call.init.headers as Record<string, string>)["PayPal-Request-Id"]).toBeUndefined();
  });
});
