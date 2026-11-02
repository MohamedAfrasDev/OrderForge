// Fixed-window, in-memory rate limiter. State lives in one server instance, so on a
// multi-instance host each instance counts separately: this is a cheap brake on abuse
// (link guessing, intake spam), not a precise quota.

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

export type RateLimiter = {
  check(key: string): RateLimitResult;
  size(): number;
};

type Options = {
  limit: number;
  windowMs: number;
  /** Upper bound on tracked keys, so a flood of distinct keys cannot exhaust memory. */
  maxKeys?: number;
  now?: () => number;
};

export function createRateLimiter(options: Options): RateLimiter {
  const { limit, windowMs, maxKeys = 10_000, now = Date.now } = options;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error("windowMs must be a positive integer");

  const windows = new Map<string, { count: number; resetAt: number }>();

  function evict(at: number) {
    for (const [key, w] of windows) if (w.resetAt <= at) windows.delete(key);
    // Still full of live keys: drop the oldest first (Map keeps insertion order), leaving room for one more.
    for (const key of windows.keys()) {
      if (windows.size < maxKeys) break;
      windows.delete(key);
    }
  }

  return {
    check(key) {
      const at = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= at) {
        if (windows.size >= maxKeys) evict(at);
        w = { count: 0, resetAt: at + windowMs };
        windows.set(key, w);
      }
      w.count += 1;
      return {
        allowed: w.count <= limit,
        retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - at) / 1000)),
      };
    },
    size: () => windows.size,
  };
}
