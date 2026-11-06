// The brakes on the agent API: a per-address and per-shop rate limit in the handlers (429 with Retry-After, before anything is read or checked),
// and the fingerprint of an address that is used as a key instead of the address.
import { describe, expect, it } from "vitest";
import { handleCreateRequest, handleDescribeStore, handleListStores, handleReadRequest, type AgentApiDeps, type AgentApiService } from "@/lib/agent-api/handlers";
import { AGENT_LIMITS, addressKey, createAgentLimits } from "@/lib/agent-api/limits";
import { errorSchema } from "@/lib/agent-api/schemas";

const req = (ip?: string, init: RequestInit = {}) => new Request("https://shop.example/x", { ...init, headers: { ...(ip ? { "x-forwarded-for": ip } : {}), ...(init.headers as Record<string, string> | undefined) } });

describe("addressKey", () => {
  it("is a short fingerprint, not the address", () => {
    const key = addressKey(req("203.0.113.9"));
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(key).not.toContain("203");
  });

  it("is the same for the same address and different for another; only the first address of a list counts", () => {
    expect(addressKey(req("203.0.113.9"))).toBe(addressKey(req("203.0.113.9, 10.0.0.1")));
    expect(addressKey(req("203.0.113.9"))).not.toBe(addressKey(req("203.0.113.10")));
  });

  it("copes with no address at all", () => {
    expect(addressKey(req())).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("createAgentLimits", () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it(`lets one address create ${AGENT_LIMITS.createPerAddress} requests a minute, then says when to come back`, () => {
    const c = clock();
    const limits = createAgentLimits({ now: c.now });
    for (let i = 0; i < AGENT_LIMITS.createPerAddress; i++) expect(limits.check("create", req("198.51.100.1"), "demo-gift-boxes"), String(i)).toEqual({ allowed: true });
    const refused = limits.check("create", req("198.51.100.1"), "demo-gift-boxes");
    expect(refused).toMatchObject({ allowed: false });
    if (!refused.allowed) expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("starts again in the next minute", () => {
    const c = clock();
    const limits = createAgentLimits({ now: c.now });
    for (let i = 0; i <= AGENT_LIMITS.createPerAddress; i++) limits.check("create", req("198.51.100.1"), "a");
    expect(limits.check("create", req("198.51.100.1"), "a").allowed).toBe(false);
    c.advance(AGENT_LIMITS.windowMs + 1);
    expect(limits.check("create", req("198.51.100.1"), "a")).toEqual({ allowed: true });
  });

  it("counts addresses separately", () => {
    const limits = createAgentLimits({ now: clock().now });
    for (let i = 0; i <= AGENT_LIMITS.createPerAddress; i++) limits.check("create", req("198.51.100.1"), "a");
    expect(limits.check("create", req("198.51.100.1"), "a").allowed).toBe(false);
    expect(limits.check("create", req("198.51.100.2"), "a")).toEqual({ allowed: true });
  });

  it(`stops one shop taking more than ${AGENT_LIMITS.createPerStore} a minute from all addresses together`, () => {
    const limits = createAgentLimits({ now: clock().now });
    let refused = 0;
    for (let i = 0; i < AGENT_LIMITS.createPerStore + 5; i++) if (!limits.check("create", req(`192.0.2.${i}`), "demo-gift-boxes").allowed) refused += 1;
    expect(refused).toBe(5);
    expect(limits.check("create", req("192.0.2.250"), "demo-event-kits")).toEqual({ allowed: true }); // another shop is unaffected
  });

  it("reads, and browsing, have their own counters: creating never uses them up", () => {
    const limits = createAgentLimits({ now: clock().now });
    for (let i = 0; i <= AGENT_LIMITS.createPerAddress; i++) limits.check("create", req("198.51.100.1"), "a");
    expect(limits.check("read", req("198.51.100.1"))).toEqual({ allowed: true });
    expect(limits.check("list", req("198.51.100.1"))).toEqual({ allowed: true });
    expect(limits.check("describe", req("198.51.100.1"))).toEqual({ allowed: true });
  });

  it("never returns a retry time under one second", () => {
    const limits = createAgentLimits({ now: clock().now });
    for (let i = 0; i <= AGENT_LIMITS.readPerAddress; i++) limits.check("read", req("198.51.100.1"));
    const r = limits.check("read", req("198.51.100.1"));
    expect(!r.allowed && r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe("the handlers answer 429 before doing anything else", () => {
  function counting(): { deps: AgentApiDeps; calls: string[] } {
    const calls: string[] = [];
    const service: AgentApiService = {
      listStores: async () => (calls.push("list"), []),
      describeStore: async () => (calls.push("describe"), null),
      create: async () => (calls.push("create"), { ok: false, code: "NOT_FOUND" }),
      read: async () => (calls.push("read"), { ok: false, code: "NOT_FOUND" }),
    };
    return { deps: { service, baseUrl: "https://shop.example", limits: { check: () => ({ allowed: false, retryAfterSeconds: 42 }) } }, calls };
  }

  const expect429 = async (res: Response) => {
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(errorSchema.parse(await res.json())).toEqual({ error: { code: "RATE_LIMITED" } });
  };

  it("create: before the body is read, so a flood of large bodies costs nothing", async () => {
    const { deps, calls } = counting();
    let bodyRead = false;
    const request = new Request("https://shop.example/x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    Object.defineProperty(request, "text", { value: async () => ((bodyRead = true), "{}") });
    await expect429(await handleCreateRequest(deps, request, "demo-gift-boxes"));
    expect(bodyRead).toBe(false);
    expect(calls).toEqual([]);
  });

  it("read: before the token is looked at, so token guessing is slowed too", async () => {
    const { deps, calls } = counting();
    await expect429(await handleReadRequest(deps, req("198.51.100.1", { headers: { authorization: "Bearer abc" } }), "5b0e6a3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b"));
    expect(calls).toEqual([]);
  });

  it("list and describe", async () => {
    const { deps, calls } = counting();
    await expect429(await handleListStores(deps, req("198.51.100.1")));
    await expect429(await handleDescribeStore(deps, "demo-gift-boxes", req("198.51.100.1")));
    expect(calls).toEqual([]);
  });

  it("the daily cap's RATE_LIMITED result is a 429 with its own retry time", async () => {
    const service: AgentApiService = {
      listStores: async () => [],
      describeStore: async () => null,
      create: async () => ({ ok: false, code: "RATE_LIMITED", retryAfterSeconds: 3600 }),
      read: async () => ({ ok: false, code: "NOT_FOUND" }),
    };
    const res = await handleCreateRequest({ service, baseUrl: "https://shop.example" }, new Request("https://shop.example/x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), "demo-gift-boxes");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3600");
  });
});
