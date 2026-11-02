// Evidence label for every test in this file: MOCKED. fetch is replaced; PayPal is never contacted.
import { describe, expect, it, vi } from "vitest";
import { cents } from "@/lib/money";
import { createPayPalClient } from "@/lib/paypal/client";
import { toMinorUnits, toPayPalAmount } from "@/lib/paypal/types";

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret-value-123456";
const ACCESS_TOKEN = "A21-test-access-token-value";
const REQUEST_ID = "req-0123456789abcdef";

type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const tokenResponse = (expiresIn = 32400) => json({ access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: expiresIn });

/** A fetch mock: the first call to the token endpoint gets a token, every other call is answered by `api`. */
function mockFetch(api: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: { ...init, headers: { ...(init?.headers as Record<string, string>) } } } as Call;
    calls.push(call);
    if (call.url.endsWith("/v1/oauth2/token")) return tokenResponse();
    return api(call);
  });
  return { fetch: fn as unknown as typeof fetch, calls, apiCalls: () => calls.filter((c) => !c.url.endsWith("/v1/oauth2/token")) };
}

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return createPayPalClient({ env: "sandbox", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fetchImpl, ...extra });
}

describe("amount helpers", () => {
  it("formats integer cents as a decimal string without floats", () => {
    expect(toPayPalAmount(cents(108000))).toBe("1080.00");
    expect(toPayPalAmount(cents(5))).toBe("0.05");
    expect(toPayPalAmount(cents(100))).toBe("1.00");
    expect(toPayPalAmount(cents(0))).toBe("0.00");
  });

  it("parses PayPal amount strings back to cents, strictly", () => {
    expect(toMinorUnits("1080.00")).toBe(108000);
    expect(toMinorUnits("0.05")).toBe(5);
    expect(toMinorUnits("12")).toBeNull();
    expect(toMinorUnits("12.5")).toBeNull();
    expect(toMinorUnits("1,080.00")).toBeNull();
    expect(toMinorUnits("-1.00")).toBeNull();
    expect(toMinorUnits("")).toBeNull();
  });
});

describe("configuration guards", () => {
  it("refuses anything but the sandbox", () => {
    expect(() => createPayPalClient({ env: "live" as "sandbox", clientId: "a", clientSecret: "b" })).toThrow(/sandbox/i);
  });

  it("only accepts the sandbox host or a local fake as base URL", () => {
    const ok = (baseUrl: string) => createPayPalClient({ env: "sandbox", clientId: "a", clientSecret: "b", baseUrl });
    expect(() => ok("https://api-m.sandbox.paypal.com")).not.toThrow();
    expect(() => ok("http://127.0.0.1:4010")).not.toThrow();
    expect(() => ok("http://localhost:4010")).not.toThrow();
    expect(() => ok("https://api-m.paypal.com")).toThrow();
    expect(() => ok("https://evil.example.com")).toThrow();
  });
});

describe("access token", () => {
  it("requests a client-credentials token with basic auth", async () => {
    const m = mockFetch(() => json({ id: "ORDER1", status: "CREATED" }, 201));
    await client(m.fetch).getOrder("ORDER1");

    const tokenCall = m.calls[0];
    expect(tokenCall.url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(tokenCall.init.method).toBe("POST");
    expect(tokenCall.init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(tokenCall.init.headers.Authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(String(tokenCall.init.body)).toBe("grant_type=client_credentials");
  });

  it("caches the token across calls", async () => {
    const m = mockFetch(() => json({ id: "ORDER1", status: "CREATED" }));
    const c = client(m.fetch);
    await c.getOrder("ORDER1");
    await c.getOrder("ORDER2");
    expect(m.calls.filter((x) => x.url.endsWith("/v1/oauth2/token"))).toHaveLength(1);
  });

  it("shares one token request between concurrent calls", async () => {
    const m = mockFetch(() => json({ id: "ORDER1", status: "CREATED" }));
    const c = client(m.fetch);
    await Promise.all([c.getOrder("ORDER1"), c.getOrder("ORDER2"), c.getOrder("ORDER3")]);
    expect(m.calls.filter((x) => x.url.endsWith("/v1/oauth2/token"))).toHaveLength(1);
  });

  it("fetches a new token once the cached one is about to expire", async () => {
    let now = 1_000_000;
    const m = mockFetch(() => json({ id: "ORDER1", status: "CREATED" }));
    const c = client(m.fetch, { now: () => now });
    await c.getOrder("ORDER1");
    now += 32400 * 1000; // past expiry
    await c.getOrder("ORDER1");
    expect(m.calls.filter((x) => x.url.endsWith("/v1/oauth2/token"))).toHaveLength(2);
  });

  it("reports not_sent, and never calls the API, when the token request fails", async () => {
    const fn = vi.fn(async () => json({ error: "invalid_client" }, 401));
    const result = await client(fn as unknown as typeof fetch).captureAuthorization("AUTH1", REQUEST_ID);
    expect(result).toMatchObject({ kind: "not_sent" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reports not_sent when the token request times out or the network fails", async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await client(fn as unknown as typeof fetch).voidAuthorization("AUTH1", REQUEST_ID);
    expect(result.kind).toBe("not_sent");
  });

  it("drops the cached token after the API rejects it, without retrying", async () => {
    let apiHits = 0;
    const m = mockFetch(() => {
      apiHits += 1;
      return apiHits === 1 ? json({ name: "AUTHENTICATION_FAILURE" }, 401) : json({ id: "ORDER1", status: "CREATED" });
    });
    const c = client(m.fetch);
    expect((await c.getOrder("ORDER1")).kind).toBe("provider_error");
    expect(m.apiCalls()).toHaveLength(1);
    expect((await c.getOrder("ORDER1")).kind).toBe("ok");
    expect(m.calls.filter((x) => x.url.endsWith("/v1/oauth2/token"))).toHaveLength(2);
  });
});

describe("createOrder", () => {
  it("creates an AUTHORIZE order from an integer amount, with an idempotency key", async () => {
    const m = mockFetch(() => json({ id: "5O190127TN364715T", status: "CREATED" }, 201));
    const result = await client(m.fetch).createOrder({
      amount: cents(108000),
      referenceId: "purchase-1",
      requestId: REQUEST_ID,
    });

    const call = m.apiCalls()[0];
    expect(call.url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call.init.headers["PayPal-Request-Id"]).toBe(REQUEST_ID);
    expect(call.init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(call.init.body))).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [{ reference_id: "purchase-1", amount: { currency_code: "USD", value: "1080.00" } }],
    });
    expect(result).toEqual({ kind: "ok", requestId: REQUEST_ID, data: { id: "5O190127TN364715T", status: "CREATED" } });
  });

  it("rejects non-positive amounts before sending anything", () => {
    const m = mockFetch(() => json({}));
    expect(() => client(m.fetch).createOrder({ amount: cents(0), referenceId: "p", requestId: REQUEST_ID })).toThrow();
    expect(m.calls).toHaveLength(0);
  });

  it("treats a 2xx body without an order id as malformed", async () => {
    const m = mockFetch(() => json({ status: "CREATED" }, 201));
    const result = await client(m.fetch).createOrder({ amount: cents(100), referenceId: "p", requestId: REQUEST_ID });
    expect(result.kind).toBe("malformed");
  });
});

describe("authorizeOrder", () => {
  const authorizeBody = {
    id: "ORDER1",
    status: "COMPLETED",
    purchase_units: [
      {
        payments: {
          authorizations: [
            {
              id: "AUTH-123",
              status: "CREATED",
              amount: { currency_code: "USD", value: "1080.00" },
              expiration_time: "2026-12-01T00:00:00Z",
            },
          ],
        },
      },
    ],
  };

  it("returns the authorization id from purchase_units[0].payments.authorizations[0]", async () => {
    const m = mockFetch(() => json(authorizeBody, 201));
    const result = await client(m.fetch).authorizeOrder("ORDER1", REQUEST_ID);

    const call = m.apiCalls()[0];
    expect(call.url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER1/authorize");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["PayPal-Request-Id"]).toBe(REQUEST_ID);
    expect(result).toEqual({
      kind: "ok",
      requestId: REQUEST_ID,
      data: {
        orderId: "ORDER1",
        orderStatus: "COMPLETED",
        authorizationId: "AUTH-123",
        authorizationStatus: "CREATED",
        amountMinor: 108000,
        currency: "USD",
        expirationTime: "2026-12-01T00:00:00Z",
      },
    });
  });

  it("is malformed, not success, when the authorization id is missing", async () => {
    const m = mockFetch(() => json({ id: "ORDER1", status: "COMPLETED", purchase_units: [{ payments: {} }] }, 201));
    expect((await client(m.fetch).authorizeOrder("ORDER1", REQUEST_ID)).kind).toBe("malformed");
  });

  it("is malformed when the amount is not an exact two-decimal USD string", async () => {
    const body = structuredClone(authorizeBody);
    body.purchase_units[0].payments.authorizations[0].amount.value = "1080";
    const m = mockFetch(() => json(body, 201));
    expect((await client(m.fetch).authorizeOrder("ORDER1", REQUEST_ID)).kind).toBe("malformed");
  });
});

describe("captureAuthorization", () => {
  it("posts to the authorization's capture endpoint with the idempotency key", async () => {
    const m = mockFetch(() =>
      json({ id: "CAP-1", status: "COMPLETED", amount: { currency_code: "USD", value: "1080.00" }, final_capture: true }, 201),
    );
    const result = await client(m.fetch).captureAuthorization("AUTH-123", REQUEST_ID, {
      amount: cents(108000),
      finalCapture: true,
    });

    const call = m.apiCalls()[0];
    expect(call.url).toBe("https://api-m.sandbox.paypal.com/v2/payments/authorizations/AUTH-123/capture");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["PayPal-Request-Id"]).toBe(REQUEST_ID);
    expect(JSON.parse(String(call.init.body))).toEqual({
      amount: { currency_code: "USD", value: "1080.00" },
      final_capture: true,
    });
    expect(result).toEqual({
      kind: "ok",
      requestId: REQUEST_ID,
      data: { captureId: "CAP-1", status: "COMPLETED", amountMinor: 108000, currency: "USD" },
    });
  });

  it("sends an empty JSON body when no amount is given (capture the full authorization)", async () => {
    const m = mockFetch(() => json({ id: "CAP-1", status: "COMPLETED" }, 201));
    await client(m.fetch).captureAuthorization("AUTH-123", REQUEST_ID);
    expect(JSON.parse(String(m.apiCalls()[0].init.body))).toEqual({});
  });
});

describe("voidAuthorization", () => {
  it("treats 204 No Content as a successful void", async () => {
    const m = mockFetch(() => new Response(null, { status: 204 }));
    const result = await client(m.fetch).voidAuthorization("AUTH-123", REQUEST_ID);
    const call = m.apiCalls()[0];
    expect(call.url).toBe("https://api-m.sandbox.paypal.com/v2/payments/authorizations/AUTH-123/void");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["PayPal-Request-Id"]).toBe(REQUEST_ID);
    expect(result).toEqual({ kind: "ok", requestId: REQUEST_ID, data: { authorizationId: "AUTH-123", status: "VOIDED" } });
  });

  it("also accepts a 200 representation", async () => {
    const m = mockFetch(() => json({ id: "AUTH-123", status: "VOIDED" }));
    expect(await client(m.fetch).voidAuthorization("AUTH-123", REQUEST_ID)).toMatchObject({
      kind: "ok",
      data: { authorizationId: "AUTH-123", status: "VOIDED" },
    });
  });

  it("surfaces 409 and 422 as provider errors rather than guessing why", async () => {
    for (const status of [409, 422]) {
      const m = mockFetch(() => json({ name: "AUTHORIZATION_ALREADY_CAPTURED", debug_id: "dbg-1" }, status));
      expect(await client(m.fetch).voidAuthorization("AUTH-123", REQUEST_ID)).toMatchObject({
        kind: "provider_error",
        status,
        errorName: "AUTHORIZATION_ALREADY_CAPTURED",
        debugId: "dbg-1",
      });
    }
  });
});

describe("read endpoints", () => {
  it("getOrder, getAuthorization and getCapture are GETs without an idempotency key", async () => {
    const m = mockFetch((call) =>
      call.url.includes("/captures/")
        ? json({ id: "CAP-1", status: "COMPLETED", amount: { currency_code: "USD", value: "1080.00" } })
        : call.url.includes("/authorizations/")
          ? json({ id: "AUTH-123", status: "CREATED", amount: { currency_code: "USD", value: "1080.00" } })
          : json({ id: "ORDER1", status: "APPROVED" }),
    );
    const c = client(m.fetch);
    expect(await c.getOrder("ORDER1")).toMatchObject({ kind: "ok", data: { id: "ORDER1", status: "APPROVED" } });
    expect(await c.getAuthorization("AUTH-123")).toMatchObject({
      kind: "ok",
      data: { id: "AUTH-123", status: "CREATED", amountMinor: 108000 },
    });
    expect(await c.getCapture("CAP-1")).toMatchObject({
      kind: "ok",
      data: { captureId: "CAP-1", status: "COMPLETED", amountMinor: 108000 },
    });

    const urls = m.apiCalls().map((c2) => `${c2.init.method} ${c2.url.replace("https://api-m.sandbox.paypal.com", "")}`);
    expect(urls).toEqual([
      "GET /v2/checkout/orders/ORDER1",
      "GET /v2/payments/authorizations/AUTH-123",
      "GET /v2/payments/captures/CAP-1",
    ]);
    for (const call of m.apiCalls()) expect(call.init.headers["PayPal-Request-Id"]).toBeUndefined();
  });
});

describe("failure handling", () => {
  it("returns provider errors with status, name and debug id, and never retries", async () => {
    const m = mockFetch(() => json({ name: "UNPROCESSABLE_ENTITY", message: "nope", debug_id: "abc123" }, 422));
    const result = await client(m.fetch).captureAuthorization("AUTH-123", REQUEST_ID);
    expect(result).toMatchObject({
      kind: "provider_error",
      status: 422,
      errorName: "UNPROCESSABLE_ENTITY",
      debugId: "abc123",
      requestId: REQUEST_ID,
    });
    expect(m.apiCalls()).toHaveLength(1);
  });

  it("handles an error body that is not JSON", async () => {
    const m = mockFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await client(m.fetch).getOrder("ORDER1")).toMatchObject({ kind: "provider_error", status: 502 });
  });

  it("reports a timeout, keeping the request id, and does not retry", async () => {
    const m = mockFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const result = await client(m.fetch, { timeoutMs: 25 }).captureAuthorization("AUTH-123", REQUEST_ID);
    expect(result).toEqual({ kind: "timeout", cause: "timeout", requestId: REQUEST_ID });
    expect(m.apiCalls()).toHaveLength(1);
  });

  it("treats a dropped connection after sending as an unknown outcome too", async () => {
    const m = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await client(m.fetch).captureAuthorization("AUTH-123", REQUEST_ID)).toEqual({
      kind: "timeout",
      cause: "network",
      requestId: REQUEST_ID,
    });
  });
});

describe("input validation", () => {
  const c = () => client(mockFetch(() => json({})).fetch);

  it.each(["", "x".repeat(10_001)])("rejects an idempotency key of the wrong length", (id) => {
    expect(() => c().captureAuthorization("AUTH-123", id)).toThrow();
  });

  it.each(["../orders", "A B", "A/B", "A?x=1", "", "x".repeat(65)])("rejects unsafe resource id %j", (id) => {
    expect(() => c().getOrder(id)).toThrow();
    expect(() => c().voidAuthorization(id, REQUEST_ID)).toThrow();
  });
});

describe("secrets", () => {
  it("never puts the client secret or access token in a result", async () => {
    const outcomes = [
      await client(mockFetch(() => json({ id: "ORDER1", status: "CREATED" }, 201)).fetch).createOrder({
        amount: cents(100), referenceId: "p", requestId: REQUEST_ID,
      }),
      await client(mockFetch(() => json({ name: "X" }, 422)).fetch).getOrder("ORDER1"),
      await client(
        mockFetch(() => {
          throw new TypeError("fetch failed");
        }).fetch,
      ).getOrder("ORDER1"),
    ];
    const serialized = JSON.stringify(outcomes);
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"));
  });
});

describe("createOrder approval link", () => {
  const create = (links: unknown) =>
    client(mockFetch(() => json({ id: "ORDER1", status: "CREATED", links }, 201)).fetch).createOrder({
      amount: cents(100),
      referenceId: "p",
      requestId: REQUEST_ID,
    });

  it("returns the payer-action link when present", async () => {
    const result = await create([
      { rel: "self", href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER1" },
      { rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" },
      { rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1&x=1" },
    ]);
    expect(result).toMatchObject({ kind: "ok", data: { approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1&x=1" } });
  });

  it("falls back to the approve link", async () => {
    const result = await create([{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }]);
    expect(result).toMatchObject({ kind: "ok", data: { approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" } });
  });

  it.each([
    ["a non-PayPal host", [{ rel: "approve", href: "https://evil.example.com/checkoutnow" }]],
    ["a lookalike host", [{ rel: "approve", href: "https://paypal.com.evil.example/x" }]],
    ["plain http", [{ rel: "approve", href: "http://www.sandbox.paypal.com/x" }]],
    ["a javascript: URL", [{ rel: "approve", href: "javascript:alert(1)" }]],
    ["no usable link", [{ rel: "self", href: "https://api-m.sandbox.paypal.com/x" }]],
    ["no links at all", undefined],
  ])("never returns %s", async (_label, links) => {
    const result = await create(links);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.data.approveUrl).toBeUndefined();
  });
});

describe("createOrder return URLs (needed when the buyer approves via a link, not the PayPal popup)", () => {
  const create = (extra: Record<string, unknown>) => {
    const m = mockFetch(() => json({ id: "ORDER1", status: "PAYER_ACTION_REQUIRED" }, 201));
    const promise = client(m.fetch).createOrder({
      amount: cents(1080),
      referenceId: "p",
      requestId: REQUEST_ID,
      ...extra,
    } as Parameters<ReturnType<typeof client>["createOrder"]>[0]);
    return { m, promise };
  };

  it("sends no payment_source when no return URL is given (unchanged behaviour)", async () => {
    const { m, promise } = create({});
    await promise;
    expect(JSON.parse(String(m.apiCalls()[0].init.body))).not.toHaveProperty("payment_source");
  });

  it("puts the URLs in payment_source.paypal.experience_context and asks for a return to the app", async () => {
    const { m, promise } = create({ returnUrl: "https://app.example.com/back", cancelUrl: "https://app.example.com/cancel" });
    await promise;
    expect(JSON.parse(String(m.apiCalls()[0].init.body))).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [{ reference_id: "p", amount: { currency_code: "USD", value: "10.80" } }],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: "https://app.example.com/back",
            cancel_url: "https://app.example.com/cancel",
            user_action: "CONTINUE",
            shipping_preference: "NO_SHIPPING",
          },
        },
      },
    });
  });

  it("uses the return URL for cancel too when no cancel URL is given", async () => {
    const { m, promise } = create({ returnUrl: "https://app.example.com/back" });
    await promise;
    const body = JSON.parse(String(m.apiCalls()[0].init.body));
    expect(body.payment_source.paypal.experience_context.cancel_url).toBe("https://app.example.com/back");
  });

  it.each([
    ["http://app.example.com/back"],
    ["javascript:alert(1)"],
    ["ftp://app.example.com/back"],
    ["not a url"],
    [""],
  ])("refuses an unsafe return URL %j before sending anything", (returnUrl) => {
    const m = mockFetch(() => json({}));
    expect(() =>
      client(m.fetch).createOrder({ amount: cents(100), referenceId: "p", requestId: REQUEST_ID, returnUrl }),
    ).toThrow();
    expect(m.calls).toHaveLength(0);
  });

  it("allows http only for a local address", () => {
    const m = mockFetch(() => json({ id: "O", status: "CREATED" }, 201));
    expect(() =>
      client(m.fetch).createOrder({ amount: cents(100), referenceId: "p", requestId: REQUEST_ID, returnUrl: "http://localhost:3000/back" }),
    ).not.toThrow();
  });
});
