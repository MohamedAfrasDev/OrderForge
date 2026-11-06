import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntakeResult } from "@/domain/intake";
import type { CustomerAccess } from "@/lib/access/inquiry-reads";
import type { ModelPort } from "@/lib/ai";
import { startInquiry } from "@/services/intake/start";
import { runIntakeTurn } from "@/services/intake/turn";

// The one place where a request is started and read once. The store page's form and the /demo buttons both call it, so a prepared
// request takes exactly the path a typed one takes. Not a server action itself (it takes a database client and a model), so the
// browser can never call it directly.

export type StartFlowDeps = {
  db: SupabaseClient;
  accessSecret: string;
  model: ModelPort;
  /** Turns the signed link into the verified inquiry the intake turn requires. */
  authorize: (token: string) => Promise<CustomerAccess>;
};

/**
 * The inquiry and its first message are stored first; then the assistant reads the message once. Whatever the assistant does (even fail),
 * the caller gets the customer's link, because the order room offers a retry for an unanswered message.
 */
export async function startAndAnswer(
  deps: StartFlowDeps,
  slug: string,
  message: unknown,
  email: string | null,
  ctx: { now: string; correlationId: string },
): Promise<IntakeResult<{ accessToken: string; inquiryId: string }>> {
  const started = await startInquiry(deps.db, { accessSecret: deps.accessSecret }, slug, message, ctx, { email });
  if (!started.ok) return started;

  const { accessToken, inquiryId } = started.value;
  const access = await deps.authorize(accessToken);
  if (access.ok) {
    const first = await deps.db.from("messages").select("id").eq("inquiry_id", inquiryId).eq("role", "customer").order("created_at").limit(1).maybeSingle();
    if (first.data) {
      try {
        await runIntakeTurn(deps.db, { model: deps.model }, access.inquiry.id, first.data.id as string, { ...ctx, now: new Date().toISOString() });
      } catch {
        // Nothing to show here: the order room offers a retry for an unanswered message.
      }
    }
  }
  return { ok: true, value: { accessToken, inquiryId } };
}
