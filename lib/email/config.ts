/** What the email provider is configured with. Pure: decides whether a real provider may exist at all. */
export type ResendConfig = { apiKey: string; from: string; replyTo?: string };

export type EmailEnvSource = { RESEND_API_KEY?: string; EMAIL_FROM?: string; EMAIL_REPLY_TO?: string };
export type RuntimeFlags = {
  /** Set by CI systems (GitHub Actions sets CI=true). */
  ci: boolean;
  /** NODE_ENV is "test", or a test runner is running. */
  test: boolean;
};

/**
 * The real provider's settings, or null when no real email may be sent: the key or the sender is missing, or this is a test or a CI run.
 * Under test and in CI the real provider is never built, even if a key is present in the environment.
 */
export function resendConfigFrom(env: EmailEnvSource, flags: RuntimeFlags): ResendConfig | null {
  if (flags.ci || flags.test) return null;
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return null;
  return { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM, ...(env.EMAIL_REPLY_TO ? { replyTo: env.EMAIL_REPLY_TO } : {}) };
}
