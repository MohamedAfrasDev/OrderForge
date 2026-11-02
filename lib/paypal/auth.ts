import { z } from "zod";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "auth_failed" | "timeout" | "network" };

type TokenProviderOptions = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetch: typeof fetch;
  timeoutMs: number;
  now: () => number;
};

/**
 * Caches the OAuth access token in memory and shares one in-flight request between
 * concurrent callers. The token and secret are never logged or returned to callers
 * other than as the bearer value used inside the client.
 */
export function createTokenProvider(options: TokenProviderOptions) {
  const { baseUrl, clientId, clientSecret, fetch: fetchImpl, timeoutMs, now } = options;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<TokenResult> | undefined;

  async function request(): Promise<TokenResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, reason: "auth_failed" };

      const parsed = tokenSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) return { ok: false, reason: "auth_failed" };

      // Refresh a little early so a token never expires mid-request.
      const lifetimeMs = parsed.data.expires_in * 1000;
      cached = { token: parsed.data.access_token, expiresAt: now() + lifetimeMs - Math.min(60_000, lifetimeMs / 2) };
      return { ok: true, token: cached.token };
    } catch (error) {
      return { ok: false, reason: error instanceof Error && error.name === "AbortError" ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async get(): Promise<TokenResult> {
      if (cached && now() < cached.expiresAt) return { ok: true, token: cached.token };
      inflight ??= request().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    /** Called when PayPal rejects the token, so the next call fetches a fresh one. */
    invalidate() {
      cached = undefined;
    },
  };
}
