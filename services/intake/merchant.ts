import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntakeResult } from "@/domain/intake";
import { LIMITS, appendMessage, auditIntake, checkMessageBody, loadInquiry, type ServiceContext } from "./shared";

export type MerchantReplyActor = { userId: string; merchantId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The merchant answers an inquiry that was handed to them. Only the merchant who owns the inquiry can (another merchant's is
 * `INQUIRY_NOT_FOUND`, the same answer as one that does not exist), and only while it is with the merchant. The reply is a
 * `merchant` message in the conversation the customer reads; the audit trail records who replied, never what was said.
 */
export async function replyAsMerchant(db: SupabaseClient, actor: MerchantReplyActor, inquiryId: unknown, body: unknown, ctx: ServiceContext): Promise<IntakeResult<void>> {
  const checked = checkMessageBody(body);
  if (!checked.ok) return { ok: false, code: checked.code };
  if (typeof inquiryId !== "string" || !UUID.test(inquiryId)) return { ok: false, code: "INVALID_INPUT" };

  const inquiry = await loadInquiry(db, inquiryId);
  if (!inquiry || inquiry.merchantId !== actor.merchantId) return { ok: false, code: "INQUIRY_NOT_FOUND" };
  if (inquiry.status !== "REVIEW_REQUIRED") return { ok: false, code: "ILLEGAL_TRANSITION", cause: `the inquiry is ${inquiry.status}` };

  const count = await db.from("messages").select("id", { count: "exact", head: true }).eq("inquiry_id", inquiryId);
  if (count.error) throw new Error(`count messages: ${count.error.message}`);
  if ((count.count ?? 0) >= LIMITS.messages * 2) return { ok: false, code: "LIMIT_REACHED" };

  await appendMessage(db, inquiryId, "merchant", checked.text, ctx);
  await auditIntake(db, ctx, `merchant:${actor.userId}`, "intake.merchant_replied", inquiryId);
  return { ok: true, value: undefined };
}
