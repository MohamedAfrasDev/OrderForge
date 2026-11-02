import { expect, test } from "@playwright/test";

// Only rejections that happen BEFORE the route asks PayPal anything are tested here, so the test
// server never contacts PayPal. Evidence label: real route, no PayPal traffic.
const URL = "/api/webhooks/paypal";

const goodEvent = JSON.stringify({ id: "WH-E2E-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} });

const signedHeaders = {
  "content-type": "application/json",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "paypal-transmission-sig": "c2ln",
  "paypal-transmission-time": "2026-11-05T09:30:00Z",
};

test.describe("PayPal webhook route", () => {
  test("rejects an unsigned request", async ({ request }) => {
    const response = await request.post(URL, { data: goodEvent, headers: { "content-type": "application/json" } });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_signature" });
  });

  test("rejects a request whose certificate URL is not PayPal's", async ({ request }) => {
    const response = await request.post(URL, {
      data: goodEvent,
      headers: { ...signedHeaders, "paypal-cert-url": "https://evil.example.com/cert" },
    });
    expect(response.status()).toBe(400);
  });

  test("rejects a signed-looking request with an unreadable body", async ({ request }) => {
    const response = await request.post(URL, { data: "not json at all", headers: signedHeaders });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_body" });
  });

  test("rejects a body with fields smuggled after the event", async ({ request }) => {
    const smuggled = '{"id":"E","event_type":"X","resource":{}},"webhook_id":"attacker"';
    const response = await request.post(URL, { data: smuggled, headers: signedHeaders });
    expect(response.status()).toBe(400);
  });

  test("only accepts POST", async ({ request }) => {
    expect((await request.get(URL)).status()).toBe(405);
  });

  test("never caches its answers", async ({ request }) => {
    const response = await request.post(URL, { data: goodEvent, headers: { "content-type": "application/json" } });
    expect(response.headers()["cache-control"]).toContain("no-store");
  });
});
