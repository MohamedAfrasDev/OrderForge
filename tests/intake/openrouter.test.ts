// The OpenRouter client against a LOCAL fake HTTP server only: no real network, no real model, no real key.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { askSchema } from "@/domain/intake";
import { DEFAULT_FALLBACK_MODEL, DEFAULT_PRIMARY_MODEL, createFakeModel, createOpenRouterModel, type ModelRequest } from "@/lib/ai";
import { parseServerEnv } from "@/lib/env-schema";

const KEY = "sk-or-test-key-that-must-never-leak-0123456789";
const PRIMARY = "google/gemma-4-31b-it:free";
const FALLBACK = "openai/gpt-oss-120b";

type Recorded = { auth: string | undefined; body: Record<string, unknown> };
type Step = { status?: number; body?: unknown; raw?: string; hang?: boolean; drop?: boolean; echoAuth?: boolean };

let server: Server;
let baseUrl = "";
let steps: Step[] = [];
let seen: Recorded[] = [];

const ok = (content: string, model = PRIMARY): Step => ({ status: 200, body: { id: "x", model, choices: [{ message: { role: "assistant", content } }] } });
const answer = (question: string): Step => ok(JSON.stringify({ question }));

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const text = await readBody(req);
    const rec: Recorded = { auth: req.headers.authorization, body: JSON.parse(text || "{}") };
    seen.push(rec);
    const step = steps.shift() ?? { status: 500, body: { error: { message: "no scripted step" } } };
    if (step.hang) return; // never answers
    if (step.drop) return void req.socket.destroy();
    res.statusCode = step.status ?? 200;
    res.setHeader("content-type", "application/json");
    if (step.echoAuth) return void res.end(JSON.stringify({ error: { message: `bad key ${req.headers.authorization}` } }));
    res.end(step.raw ?? JSON.stringify(step.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  steps = [];
  seen = [];
});

const client = (over: Record<string, unknown> = {}) => createOpenRouterModel({ apiKey: KEY, model: PRIMARY, fallbackModel: FALLBACK, baseUrl, timeoutMs: 300, ...over });

const messages = [
  { role: "system" as const, content: "system text" },
  { role: "user" as const, content: "user text" },
];
const request = (over: Partial<ModelRequest<{ question: string }>> = {}): ModelRequest<{ question: string }> => ({
  kind: "ask",
  messages,
  jsonSchema: z.toJSONSchema(askSchema) as Record<string, unknown>,
  parse: (raw) => {
    const r = askSchema.safeParse(raw);
    return r.success ? { ok: true, value: r.data } : { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "answer"}: ${i.message}`) };
  },
  ...over,
});
const models = () => seen.map((s) => s.body.model);

describe("a good answer", () => {
  it("posts the prompt with the key, a strict JSON schema and temperature 0, and returns the parsed value and the model that answered", async () => {
    steps = [answer("How many boxes?")];
    const out = await client().complete(request());
    expect(out).toMatchObject({ ok: true, value: { question: "How many boxes?" }, model: PRIMARY, calls: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
    const b = seen[0]!.body as { model: string; messages: unknown; temperature: number; response_format: { type: string; json_schema: { name: string; strict: boolean; schema: unknown } } };
    expect(b.model).toBe(PRIMARY);
    expect(b.messages).toEqual(messages);
    expect(b.temperature).toBe(0);
    expect(b.response_format.type).toBe("json_schema");
    expect(b.response_format.json_schema).toMatchObject({ name: "ask", strict: true });
    expect(b.response_format.json_schema.schema).toEqual(z.toJSONSchema(askSchema));
  });

  it("reads an answer wrapped in a code fence", async () => {
    steps = [ok('```json\n{"question":"How many boxes?"}\n```')];
    expect(await client().complete(request())).toMatchObject({ ok: true, value: { question: "How many boxes?" } });
  });
});

describe("an answer that is not usable: one retry on the same model with the reasons, never the fallback", () => {
  it("invalid JSON, then a good answer", async () => {
    steps = [ok("Sure! How many boxes?"), answer("How many boxes?")];
    const out = await client().complete(request());
    expect(out).toMatchObject({ ok: true, calls: 2, model: PRIMARY });
    expect(models()).toEqual([PRIMARY, PRIMARY]);
    const retryMessages = seen[1]!.body.messages as Array<{ role: string; content: string }>;
    expect(retryMessages.length).toBe(messages.length + 2);
    expect(retryMessages.at(-1)!.role).toBe("user");
    expect(retryMessages.at(-1)!.content).toMatch(/invalid/i);
  });

  it("a schema failure puts the validation reasons in the retry", async () => {
    steps = [ok(JSON.stringify({ question: "How many boxes?", price: 1 })), answer("How many boxes?")];
    const out = await client().complete(request());
    expect(out.ok).toBe(true);
    const retry = (seen[1]!.body.messages as Array<{ content: string }>).at(-1)!.content;
    expect(retry).toMatch(/price/);
  });

  it("two bad answers in a row end as MALFORMED after exactly two calls, and the fallback is never asked", async () => {
    steps = [ok("nonsense"), ok("still nonsense")];
    const out = await client().complete(request());
    expect(out).toMatchObject({ ok: false, failure: "MALFORMED", calls: 2, model: PRIMARY });
    expect(models()).toEqual([PRIMARY, PRIMARY]);
  });

  it("a 200 with no content is malformed, not a provider failure", async () => {
    steps = [{ status: 200, body: { choices: [] } }, { status: 200, body: { choices: [{ message: {} }] } }];
    expect(await client().complete(request())).toMatchObject({ ok: false, failure: "MALFORMED" });
    expect(models()).toEqual([PRIMARY, PRIMARY]);
  });
});

describe("a provider failure moves to the fallback model, once", () => {
  const failures: Array<[string, Step]> = [
    ["a server error", { status: 500, body: { error: { message: "boom" } } }],
    ["bad gateway", { status: 502, body: {} }],
    ["a rate limit", { status: 429, body: { error: { message: "slow down" } } }],
    ["a request timeout status", { status: 408, body: {} }],
    ["the free model no longer available", { status: 404, body: { error: { message: "No endpoints found" } } }],
    ["the provider rejecting the request", { status: 400, body: { error: { message: "unsupported" } } }],
    ["an error inside a 200 answer", { status: 200, body: { error: { code: 502, message: "provider returned error" } } }],
    ["a dropped connection", { drop: true }],
    ["no answer within the timeout", { hang: true }],
  ];

  for (const [name, step] of failures) {
    it(`${name}: the fallback answers`, async () => {
      steps = [step, ok(JSON.stringify({ question: "How many boxes?" }), FALLBACK)];
      const out = await client().complete(request());
      expect(out).toMatchObject({ ok: true, model: FALLBACK, calls: 2 });
      expect(models()).toEqual([PRIMARY, FALLBACK]);
    });
  }

  it("both models failing ends as a provider failure after two calls (a timeout is reported as one)", async () => {
    steps = [{ status: 500, body: {} }, { status: 503, body: {} }];
    expect(await client().complete(request())).toMatchObject({ ok: false, failure: "PROVIDER_FAILURE", calls: 2, model: FALLBACK });
    steps = [{ hang: true }, { hang: true }];
    expect(await client().complete(request())).toMatchObject({ ok: false, failure: "TIMEOUT", calls: 2 });
  });

  it("with no fallback configured it stops after the primary", async () => {
    steps = [{ status: 500, body: {} }];
    expect(await client({ fallbackModel: undefined }).complete(request())).toMatchObject({ ok: false, failure: "PROVIDER_FAILURE", calls: 1 });
    expect(seen).toHaveLength(1);
  });

  it("a fallback that answers badly gets its own single retry, then MALFORMED: three calls in all", async () => {
    steps = [{ status: 500, body: {} }, ok("nonsense", FALLBACK), ok("more nonsense", FALLBACK)];
    expect(await client().complete(request())).toMatchObject({ ok: false, failure: "MALFORMED", calls: 3, model: FALLBACK });
    expect(models()).toEqual([PRIMARY, FALLBACK, FALLBACK]);
  });

  it("never makes more than four calls for one request", async () => {
    steps = [ok("bad"), ok("bad"), ok("bad"), ok("bad"), ok("bad")];
    const out = await client().complete(request());
    expect(out.calls).toBeLessThanOrEqual(4);
    expect(seen.length).toBeLessThanOrEqual(4);
  });
});

describe("a refused key is not worth a second try", () => {
  it("401 and 403 stop at once: the fallback would use the same key", async () => {
    for (const status of [401, 403]) {
      seen = [];
      steps = [{ status, body: { error: { message: "no" } } }];
      expect(await client().complete(request())).toMatchObject({ ok: false, failure: "PROVIDER_FAILURE", calls: 1 });
      expect(seen).toHaveLength(1);
    }
  });
});

describe("the key never leaks", () => {
  it("not into a failure, even when the provider echoes the Authorization header back", async () => {
    steps = [{ status: 500, echoAuth: true }, { status: 500, echoAuth: true }];
    const out = await client().complete(request());
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(JSON.stringify(out)).not.toContain("sk-or-");
  });

  it("not into a malformed-answer report", async () => {
    steps = [ok(`my key is ${KEY}`), ok(`my key is ${KEY}`)];
    const out = await client().complete(request());
    expect(JSON.stringify(out)).not.toContain(KEY);
  });
});

describe("configuration is checked up front", () => {
  it("the defaults are a free primary and a paid, low-cost fallback", () => {
    expect(DEFAULT_PRIMARY_MODEL.endsWith(":free")).toBe(true);
    expect(DEFAULT_FALLBACK_MODEL.endsWith(":free")).toBe(false);
  });

  it("a paid primary is refused unless it is explicitly allowed", () => {
    expect(() => createOpenRouterModel({ apiKey: KEY, model: "openai/gpt-oss-120b", baseUrl })).toThrow(/free/i);
    expect(() => createOpenRouterModel({ apiKey: KEY, model: "openai/gpt-oss-120b", baseUrl, allowPaidPrimary: true })).not.toThrow();
  });

  it("the key is sent only to OpenRouter or a local fake", () => {
    expect(() => createOpenRouterModel({ apiKey: KEY, model: PRIMARY, baseUrl: "https://evil.example/api/v1" })).toThrow(/host/i);
    expect(() => createOpenRouterModel({ apiKey: KEY, model: PRIMARY, baseUrl: "http://openrouter.ai/api/v1" })).toThrow();
    expect(() => createOpenRouterModel({ apiKey: KEY, model: PRIMARY })).not.toThrow();
    expect(() => createOpenRouterModel({ apiKey: KEY, model: PRIMARY, baseUrl })).not.toThrow();
  });

  it("an empty key or model id is refused", () => {
    expect(() => createOpenRouterModel({ apiKey: "", model: PRIMARY })).toThrow();
    expect(() => createOpenRouterModel({ apiKey: KEY, model: "" })).toThrow();
  });
});

describe("the two optional environment variables", () => {
  const base = {
    SANDBOX_MODE: "true",
    APP_BASE_URL: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: KEY,
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: "client-id",
    NEXT_PUBLIC_PAYPAL_CLIENT_ID: "client-id",
    PAYPAL_CLIENT_SECRET: KEY,
    PAYPAL_WEBHOOK_ID: "webhook-id",
    OPENROUTER_API_KEY: KEY,
    ACCESS_LINK_SECRET: KEY,
    CRON_SECRET: KEY,
  };

  it("are optional, and an empty value counts as not set", () => {
    expect(parseServerEnv(base).OPENROUTER_MODEL).toBeUndefined();
    expect(parseServerEnv({ ...base, OPENROUTER_MODEL: "", OPENROUTER_FALLBACK_MODEL: "" }).OPENROUTER_FALLBACK_MODEL).toBeUndefined();
  });

  it("take a model id, and refuse anything that is not shaped like one", () => {
    const env = parseServerEnv({ ...base, OPENROUTER_MODEL: PRIMARY, OPENROUTER_FALLBACK_MODEL: FALLBACK });
    expect(env.OPENROUTER_MODEL).toBe(PRIMARY);
    expect(env.OPENROUTER_FALLBACK_MODEL).toBe(FALLBACK);
    expect(() => parseServerEnv({ ...base, OPENROUTER_MODEL: "has spaces; rm -rf" })).toThrow();
    expect(() => parseServerEnv({ ...base, OPENROUTER_FALLBACK_MODEL: "x".repeat(101) })).toThrow();
  });
});

describe("the scripted fake provider", () => {
  it("plays back answers by kind, runs the same parse, and records what it was asked", async () => {
    const fake = createFakeModel({ answers: { ask: [{ question: "How many boxes?" }] } });
    const out = await fake.complete(request());
    expect(out).toMatchObject({ ok: true, value: { question: "How many boxes?" }, model: "fake-model", calls: 1 });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ kind: "ask", messages });
  });

  it("reports a scripted failure, a malformed answer, and running out of answers", async () => {
    const fake = createFakeModel({ answers: { ask: [{ fail: "TIMEOUT" }, { question: "x", price: 1 }, ((req: ModelRequest<unknown>) => ({ question: `${req.messages.length} messages?` }))] } });
    expect(await fake.complete(request())).toMatchObject({ ok: false, failure: "TIMEOUT" });
    expect(await fake.complete(request())).toMatchObject({ ok: false, failure: "MALFORMED" });
    expect(await fake.complete(request())).toMatchObject({ ok: true, value: { question: "2 messages?" } });
    expect(await fake.complete(request())).toMatchObject({ ok: false, failure: "PROVIDER_FAILURE" });
  });
});
