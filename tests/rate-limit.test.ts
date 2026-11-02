import { describe, expect, it } from "vitest";
import { createRateLimiter } from "@/lib/rate-limit";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("createRateLimiter", () => {
  it("allows up to the limit, then denies with a retry hint", () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: c.now });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    const denied = limiter.check("a");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(60);
  });

  it("counts down the retry hint as the window elapses", () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    limiter.check("a");
    c.advance(45_000);
    expect(limiter.check("a")).toEqual({ allowed: false, retryAfterSeconds: 15 });
  });

  it("starts a fresh window once the old one expires", () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    c.advance(60_000);
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock().now });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("keeps memory bounded when many distinct keys arrive", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 100, now: clock().now });
    for (let i = 0; i < 1_000; i++) limiter.check(`ip-${i}`);
    expect(limiter.size()).toBeLessThanOrEqual(100);
  });

  it("rejects nonsensical configuration", () => {
    expect(() => createRateLimiter({ limit: 0, windowMs: 1000 })).toThrow();
    expect(() => createRateLimiter({ limit: 1, windowMs: 0 })).toThrow();
  });
});
