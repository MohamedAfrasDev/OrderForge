import "server-only";
import type { EmailPort } from "./port";

/**
 * The email provider for this deployment, or null when none is configured: then nothing is sent and queued emails are marked SKIPPED.
 * Tests and CI never configure one. The real provider is added in its own task, behind the same port.
 */
export function getEmailPort(): EmailPort | null {
  return null;
}
