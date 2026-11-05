import "server-only";
import { getServerEnv } from "@/lib/env";
import { resendConfigFrom } from "./config";
import type { EmailPort } from "./port";
import { createResendEmail } from "./resend";

let port: EmailPort | null | undefined;

/**
 * The email provider for this deployment, or null when no real email may be sent: then nothing is sent and queued emails are marked SKIPPED.
 * It is null without a key and a sender, and always null under test and in CI.
 */
export function getEmailPort(): EmailPort | null {
  if (port !== undefined) return port;
  const env = getServerEnv();
  const config = resendConfigFrom(env, { ci: Boolean(process.env.CI), test: process.env.NODE_ENV === "test" || Boolean(process.env.VITEST) });
  port = config ? createResendEmail(config) : null;
  return port;
}
