"use server";

import { redirect } from "next/navigation";
import { authorizeCustomerToken } from "@/lib/access/customer-session";
import { getIntakeModel } from "@/lib/ai/wiring";
import { newCorrelationId } from "@/lib/correlation";
import { getServerEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { intakeFailureMessage } from "@/services/intake/customer-messages";
import { startInquiry } from "@/services/intake/start";
import { runIntakeTurn } from "@/services/intake/turn";

export type StartState = { status: "idle" } | { status: "error"; message: string };

/**
 * A customer describes their order on a store page. The inquiry and its first message are stored first; then the assistant reads
 * it once. Whatever the assistant does (even fail), the customer lands in their order room, where a failure offers a retry.
 */
export async function startInquiryAction(slug: string, _previous: StartState, formData: FormData): Promise<StartState> {
  const db = createAdminClient();
  const ctx = { now: new Date().toISOString(), correlationId: newCorrelationId() };
  const started = await startInquiry(db, { accessSecret: getServerEnv().ACCESS_LINK_SECRET }, slug, formData.get("message"), ctx);
  if (!started.ok) return { status: "error", message: intakeFailureMessage(started.code) };

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
  redirect(`/o/${accessToken}`);
}
