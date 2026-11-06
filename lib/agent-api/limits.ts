import { sha256Hex } from "@/lib/hash";
import { createRateLimiter, type RateLimiter } from "@/lib/rate-limit";

// Brakes on the agent API, in memory per server instance (like the limits on the customer pages): they slow abuse, they are not a quota.
// The daily cap per shop is separate and counted from the audit trail (services/agent-requests/create.ts).

export type LimitKind = "list" | "describe" | "create" | "read";
export type LimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };
export type AgentLimits = { check(kind: LimitKind, request: Request, slug?: string): LimitResult };

export const AGENT_LIMITS = {
  /** Requests a single address may create per minute. */
  createPerAddress: 10,
  /** Requests all addresses together may create for one shop per minute. */
  createPerStore: 60,
  readPerAddress: 60,
  browsePerAddress: 60,
  windowMs: 60_000,
} as const;

/**
 * A short fingerprint of the caller's address, so the address itself is never a map key, a log line or an audit field. Behind Vercel the
 * platform sets x-forwarded-for, so a caller cannot choose their own.
 */
export function addressKey(request: Request): string {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return sha256Hex(`agent-api:${address}`).slice(0, 16);
}

export function createAgentLimits(options: { now?: () => number } = {}): AgentLimits {
  const make = (limit: number): RateLimiter => createRateLimiter({ limit, windowMs: AGENT_LIMITS.windowMs, ...(options.now ? { now: options.now } : {}) });
  const create = make(AGENT_LIMITS.createPerAddress);
  const perStore = make(AGENT_LIMITS.createPerStore);
  const read = make(AGENT_LIMITS.readPerAddress);
  const browse = make(AGENT_LIMITS.browsePerAddress);

  return {
    check(kind, request, slug) {
      const key = addressKey(request);
      const results =
        kind === "create"
          ? [create.check(key), perStore.check(`store:${(slug ?? "").slice(0, 64)}`)]
          : kind === "read"
            ? [read.check(key)]
            : [browse.check(`${kind}:${key}`)];
      const refused = results.find((r) => !r.allowed);
      return refused ? { allowed: false, retryAfterSeconds: Math.max(1, refused.retryAfterSeconds) } : { allowed: true };
    },
  };
}
