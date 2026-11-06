"use server";

import { redirect } from "next/navigation";
import { parseOptionalEmail } from "@/domain/notifications";
import { authorizeCustomerToken } from "@/lib/access/customer-session";
import { getIntakeModel } from "@/lib/ai/wiring";
import { notifySoon } from "@/lib/notifications/run";
import { newCorrelationId } from "@/lib/correlation";
import { getServerEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { intakeFailureMessage } from "@/services/intake/customer-messages";
import { startAndAnswer } from "./start-flow";

/** On an error the typed values come back, because the browser clears an uncontrolled form once its action finishes. */
export type StartState = { status: "idle" } | { status: "error"; message: string; values?: { message: string; email: string } };

/**
 * A customer describes their order on a store page. The inquiry and its first message are stored first; then the assistant reads
 * it once. Whatever the assistant does (even fail), the customer lands in their order room, where a failure offers a retry.
 */
export async function startInquiryAction(slug: string, _previous: StartState, formData: FormData): Promise<StartState> {
  const db = createAdminClient();
  const ctx = { now: new Date().toISOString(), correlationId: newCorrelationId() };
  const typed = { message: String(formData.get("message") ?? ""), email: String(formData.get("email") ?? "") };
  const email = parseOptionalEmail(formData.get("email"));
  if (!email.ok) return { status: "error", message: "That email address doesn't look right. Check it, or leave it empty.", values: typed };
  const started = await startAndAnswer(
    { db, accessSecret: getServerEnv().ACCESS_LINK_SECRET, model: getIntakeModel(), authorize: authorizeCustomerToken },
    slug,
    formData.get("message"),
    email.email,
    ctx,
  );
  if (!started.ok) return { status: "error", message: intakeFailureMessage(started.code), values: typed };
  notifySoon();
  redirect(`/o/${started.value.accessToken}`);
}
