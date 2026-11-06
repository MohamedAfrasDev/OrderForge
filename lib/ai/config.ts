import { DEFAULT_FALLBACK_MODEL, DEFAULT_PRIMARY_MODEL, type OpenRouterConfig } from "./openrouter";

/**
 * The OpenRouter settings the app uses, from its environment. Unset means the free primary with the paid fallback.
 * Setting `OPENROUTER_MODEL` is the explicit choice of a primary model, so it is also the opt-in for a paid one; the
 * client still refuses a paid primary that was not chosen this way. A fallback equal to the primary is no fallback
 * (the client makes one attempt), so choosing the same model for both gives a single, fast attempt.
 */
export function openRouterConfigFromEnv(env: { OPENROUTER_API_KEY: string; OPENROUTER_MODEL?: string; OPENROUTER_FALLBACK_MODEL?: string }): OpenRouterConfig {
  return {
    apiKey: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_MODEL ?? DEFAULT_PRIMARY_MODEL,
    fallbackModel: env.OPENROUTER_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL,
    allowPaidPrimary: env.OPENROUTER_MODEL !== undefined,
  };
}
