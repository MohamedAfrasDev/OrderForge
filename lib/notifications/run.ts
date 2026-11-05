import "server-only";
import { after } from "next/server";
import { notifyBestEffort } from "./best-effort";
import { getEmailPort } from "@/lib/email/wiring";
import { getServerEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { drainNotifications, type DrainSummary } from "@/services/notifications/drain";
import { enqueueNotifications } from "@/services/notifications/enqueue";

/** One pass: queue what the current state calls for, then send what is queued. Used by the scheduled run and by the best-effort pass after an action. */
export async function runNotifications(now: string = new Date().toISOString()): Promise<DrainSummary> {
  const env = getServerEnv();
  const db = createAdminClient();
  await enqueueNotifications(db, { now });
  return drainNotifications(db, { port: getEmailPort(), accessSecret: env.ACCESS_LINK_SECRET, appBaseUrl: env.APP_BASE_URL.replace(/\/+$/, "") }, { now });
}

/** Call at the end of a server action: the pass runs after the response is sent, so it never delays or fails the action. */
export function notifySoon(): void {
  try {
    after(() => notifyBestEffort(() => runNotifications()));
  } catch {
    // Outside a request there is nothing to schedule; the scheduled run covers it.
  }
}
