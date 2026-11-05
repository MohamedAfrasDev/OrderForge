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
import { startInquiry } from "@/services/intake/start";
import { runIntakeTurn } from "@/services/intake/turn";

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
  const started = await startInquiry(db, { accessSecret: getServerEnv().ACCESS_LINK_SECRET }, slug, formData.get("message"), ctx, { email: email.email });
  if (!started.ok) return { status: "error", message: intakeFailureMessage(started.code), values: typed };

  const { accessToken, inquiryId } = started.value;
  const access = await authorizeCustomerToken(accessToken);
  if (access.ok) {
    const first = await db.from("messages").select("id").eq("inquiry_id", inquiryId).eq("role", "customer").order("created_at").limit(1).maybeSingle();
    if (first.data) {
      try {
        await runIntakeTurn(db, { model: getIntakeModel() }, access.inquiry.id, first.data.id as string, { ...ctx, now: new Date().toISOString() });
      } catch {
        // Nothing to show here: the order room offers a retry for an unanswered message.
      }
    }
  }
  notifySoon();
  redirect(`/o/${accessToken}`);
}
