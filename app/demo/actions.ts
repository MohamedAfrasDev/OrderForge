"use server";

import { redirect } from "next/navigation";
import { demoScript } from "@/domain/demo/scripts";
import { authorizeCustomerToken } from "@/lib/access/customer-session";
import { getIntakeModel } from "@/lib/ai/wiring";
import { newCorrelationId } from "@/lib/correlation";
import { getServerEnv } from "@/lib/env";
import { notifySoon } from "@/lib/notifications/run";
import { createAdminClient } from "@/lib/supabase/admin";
import { startAndAnswer } from "../store/[slug]/start-flow";

/**
 * Starts the real flow from a prepared request. It takes only a store and a key and looks the text up on the server, so nothing the
 * browser sends can become the message. An unknown store or key does nothing. Otherwise it is the typed path exactly: the same start,
 * the same single read by the assistant, then the visitor lands in their order room.
 */
export async function startDemoRequest(slug: string, key: string): Promise<void> {
  const script = demoScript(slug, key);
  if (!script) return;

  const ctx = { now: new Date().toISOString(), correlationId: newCorrelationId() };
  const started = await startAndAnswer(
    { db: createAdminClient(), accessSecret: getServerEnv().ACCESS_LINK_SECRET, model: getIntakeModel(), authorize: authorizeCustomerToken },
    slug,
    script.message,
    null,
    ctx,
  );
  if (!started.ok) return; // for example the store is not on this site: no button is shown for it, and nothing is stored
  notifySoon();
  redirect(`/o/${started.value.accessToken}`);
}
