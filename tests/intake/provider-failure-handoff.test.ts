// The settings chosen for the hosted site (a paid primary, no free model in front of it) against a LOCAL fake HTTP server only:
// no real network, no real model, no real key. Label: mocked. The stored side (outage note, nothing invented, retry) is in
// tests/db/intake-outage.test.ts.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_FALLBACK_MODEL, DEFAULT_PRIMARY_MODEL, createOpenRouterModel, type ModelRequest } from "@/lib/ai";
import { openRouterConfigFromEnv } from "@/lib/ai/config";

const KEY = "sk-or-test-key-that-must-never-leak-0123456789";
const PAID = "openai/gpt-oss-120b";

let server: Server;
let baseUrl = "";
let calls = 0;
let mode: "429" | "hang" = "429";

beforeAll(async () => {
  server = createServer((req, res) => {
    calls += 1;
    req.resume();
    if (mode === "hang") return; // never answers
    res.statusCode = 429;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "temporarily rate-limited upstream" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
beforeEach(() => { calls = 0; mode = "429"; });

const request = (): ModelRequest<{ question: string }> => ({
  kind: "ask",
  messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
  jsonSchema: { type: "object" },
  parse: (raw) => {
    const r = z.object({ question: z.string() }).safeParse(raw);
    return r.success ? { ok: true, value: r.data } : { ok: false, errors: ["bad"] };
  },
});

describe("settings from the environment", () => {
  it("unset: the free primary with the paid fallback, and the paid primary is not allowed", () => {
    const c = openRouterConfigFromEnv({ OPENROUTER_API_KEY: KEY });
    expect(c).toMatchObject({ model: DEFAULT_PRIMARY_MODEL, fallbackModel: DEFAULT_FALLBACK_MODEL, allowPaidPrimary: false });
  });

  it("OPENROUTER_MODEL set to the paid model is accepted by the client, with the fallback resolving to the same model", () => {
    const c = openRouterConfigFromEnv({ OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: PAID });
    expect(c).toMatchObject({ model: PAID, fallbackModel: PAID, allowPaidPrimary: true });
    expect(() => createOpenRouterModel({ ...c, baseUrl })).not.toThrow();
  });

  it("a paid primary that was not chosen through OPENROUTER_MODEL is still refused", () => {
    expect(() => createOpenRouterModel({ apiKey: KEY, model: PAID, baseUrl })).toThrow(/free/i);
  });
});

describe("a provider failure with the hosted settings is one attempt, not two", () => {
  const model = () => createOpenRouterModel({ ...openRouterConfigFromEnv({ OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: PAID }), baseUrl, timeoutMs: 300 });

  it("a rate limit: exactly one request leaves, and the failure is reported", async () => {
    expect(await model().complete(request())).toMatchObject({ ok: false, failure: "PROVIDER_FAILURE", calls: 1 });
    expect(calls).toBe(1);
  });

  it("no answer within the timeout: exactly one request, reported as a timeout, so the wait is one timeout", async () => {
    mode = "hang";
    const started = Date.now();
    expect(await model().complete(request())).toMatchObject({ ok: false, failure: "TIMEOUT", calls: 1 });
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("for contrast, the defaults ask a second model after a failure", async () => {
    const c = openRouterConfigFromEnv({ OPENROUTER_API_KEY: KEY });
    expect(await createOpenRouterModel({ ...c, baseUrl, timeoutMs: 300 }).complete(request())).toMatchObject({ ok: false, calls: 2 });
    expect(calls).toBe(2);
  });
});
