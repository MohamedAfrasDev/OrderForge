// The real provider, tested against a LOCAL fake HTTP server only. No test here can reach api.resend.com or send an email.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resendConfigFrom } from "@/lib/email/config";
import type { EmailMessage } from "@/lib/email/port";
import { createResendEmail } from "@/lib/email/resend";

const KEY = "re_test_KEY_never_to_be_seen_0123456789";
const message: EmailMessage = { to: "sam@example.com", subject: "Your price is ready (sandbox demo)", text: "plain", html: "<p>html</p>", idempotencyKey: "notification-id-1" };

type Seen = { method?: string; url?: string; headers: IncomingMessage["headers"]; body: unknown };
let server: Server;
let base: string;
let seen: Seen[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.writeHead(200).end(JSON.stringify({ id: "x" }));

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* not json */
      }
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
afterEach(() => {
  seen = [];
  handler = (_req, res) => res.writeHead(200).end(JSON.stringify({ id: "x" }));
});

const port = (over: Partial<Parameters<typeof createResendEmail>[0]> = {}) => createResendEmail({ apiKey: KEY, from: "OrderForge Demo <onboarding@resend.dev>", baseUrl: base, ...over });

describe("the request", () => {
  it("is one POST to /emails with the key as a bearer token, the notification id as the idempotency key and the message as JSON", async () => {
    const out = await port({ replyTo: "shop@example.com" }).send(message);
    expect(out).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/emails" });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.headers["idempotency-key"]).toBe("notification-id-1");
    expect(seen[0]!.headers["content-type"]).toContain("application/json");
    expect(seen[0]!.body).toEqual({ from: "OrderForge Demo <onboarding@resend.dev>", to: ["sam@example.com"], subject: message.subject, text: "plain", html: "<p>html</p>", reply_to: "shop@example.com" });
  });

  it("leaves out reply_to when there is none, and prefers one on the message", async () => {
    await port().send(message);
    expect(seen[0]!.body).not.toHaveProperty("reply_to");
    await port({ replyTo: "a@example.com" }).send({ ...message, replyTo: "b@example.com" });
    expect(seen[1]!.body).toHaveProperty("reply_to", "b@example.com");
  });

  it("puts the key nowhere but the authorization header", async () => {
    await port().send(message);
    expect(JSON.stringify(seen[0]!.body)).not.toContain(KEY);
    expect(seen[0]!.url).not.toContain(KEY);
    const others = Object.entries(seen[0]!.headers).filter(([name]) => name !== "authorization");
    expect(JSON.stringify(others)).not.toContain(KEY);
  });
});

describe("what counts as sent", () => {
  it("any 2xx is ok", async () => {
    for (const status of [200, 201, 202]) {
      handler = (_req, res) => res.writeHead(status).end("{}");
      expect(await port().send(message), String(status)).toEqual({ ok: true });
    }
  });

  it("a 4xx, a 429 and a 5xx are failures for the outbox to retry", async () => {
    for (const status of [400, 401, 403, 422, 429, 500, 502, 503]) {
      handler = (_req, res) => res.writeHead(status).end(JSON.stringify({ message: `the key ${KEY} is wrong for sam@example.com` }));
      const out = await port().send(message);
      expect(out, String(status)).toEqual({ ok: false });
      expect(JSON.stringify(out)).not.toContain(KEY);
    }
  });

  it("a dropped connection is a failure", async () => {
    handler = (req) => req.socket.destroy();
    expect(await port().send(message)).toEqual({ ok: false });
  });

  it("a server that does not answer in time is a failure after the timeout", async () => {
    handler = () => undefined; // never replies
    const started = Date.now();
    expect(await port({ timeoutMs: 150 }).send(message)).toEqual({ ok: false });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a redirect is never followed, so the key cannot travel to another host", async () => {
    let followed = false;
    const other = createServer((_req, res) => {
      followed = true;
      res.writeHead(200).end("{}");
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    handler = (_req, res) => res.writeHead(307, { Location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/emails` }).end();
    expect(await port().send(message)).toEqual({ ok: false });
    expect(followed).toBe(false);
    other.closeAllConnections();
    await new Promise((resolve) => other.close(resolve));
  });

  it("never throws and never prints, whatever goes wrong", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    handler = (req) => req.socket.destroy();
    await expect(port().send(message)).resolves.toEqual({ ok: false });
    const throwing = createResendEmail({ apiKey: KEY, from: "a@example.com", baseUrl: base, fetchImpl: (async () => { throw new Error(`boom with ${KEY}`); }) as typeof fetch });
    const out = await throwing.send(message);
    expect(out).toEqual({ ok: false });
    expect(JSON.stringify(out)).not.toContain(KEY);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe("the host lock", () => {
  it("builds for Resend itself and for a local fake, and sends to the default host only when asked to", () => {
    expect(() => createResendEmail({ apiKey: KEY, from: "a@example.com" })).not.toThrow();
    expect(() => createResendEmail({ apiKey: KEY, from: "a@example.com", baseUrl: "https://api.resend.com" })).not.toThrow();
    expect(() => createResendEmail({ apiKey: KEY, from: "a@example.com", baseUrl: "http://127.0.0.1:4999" })).not.toThrow();
    expect(() => createResendEmail({ apiKey: KEY, from: "a@example.com", baseUrl: "http://localhost:4999" })).not.toThrow();
  });

  it("refuses any other host before anything is sent, and the refusal does not carry the key", () => {
    const bad = [
      "https://evil.example",
      "https://api.resend.com.evil.example",
      "https://evil.example/api.resend.com",
      "https://user:pass@api.resend.com",
      "https://api.resend.com:8443",
      "http://api.resend.com", // no plain http to the real host
      "http://example.com",
      "https://localhost:4999", // the local fake is plain http only
      "http://127.0.0.1.evil.example",
      "ftp://api.resend.com",
    ];
    for (const baseUrl of bad) {
      let message = "";
      try {
        createResendEmail({ apiKey: KEY, from: "a@example.com", baseUrl });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, baseUrl).toMatch(/Email host not allowed/);
      expect(message).not.toContain(KEY);
    }
  });

  it("calls the fetch it was given with the checked origin and never a different one", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => (calls.push(url), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    await createResendEmail({ apiKey: KEY, from: "a@example.com", fetchImpl }).send(message);
    expect(calls).toEqual(["https://api.resend.com/emails"]);
  });
});

describe("resendConfigFrom: when a real provider may exist", () => {
  const env = { RESEND_API_KEY: KEY, EMAIL_FROM: "onboarding@resend.dev", EMAIL_REPLY_TO: "shop@example.com" };
  const live = { ci: false, test: false };

  it("is built from a key and a sender", () => {
    expect(resendConfigFrom(env, live)).toEqual({ apiKey: KEY, from: "onboarding@resend.dev", replyTo: "shop@example.com" });
    expect(resendConfigFrom({ RESEND_API_KEY: KEY, EMAIL_FROM: "a@example.com" }, live)).toEqual({ apiKey: KEY, from: "a@example.com" });
  });

  it("is nothing without both a key and a sender", () => {
    expect(resendConfigFrom({}, live)).toBeNull();
    expect(resendConfigFrom({ RESEND_API_KEY: KEY }, live)).toBeNull();
    expect(resendConfigFrom({ EMAIL_FROM: "a@example.com" }, live)).toBeNull();
    expect(resendConfigFrom({ RESEND_API_KEY: "", EMAIL_FROM: "" }, live)).toBeNull();
  });

  it("is nothing under test or in CI, even with a key", () => {
    expect(resendConfigFrom(env, { ci: true, test: false })).toBeNull();
    expect(resendConfigFrom(env, { ci: false, test: true })).toBeNull();
    expect(resendConfigFrom(env, { ci: true, test: true })).toBeNull();
  });
});
