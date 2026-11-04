import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntakeErrorCode, IntakeResult } from "@/domain/intake";
import { createCustomerLink } from "@/lib/access/customer-link";
import { getPublicMerchant, type VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { LIMITS, auditIntake, checkMessageBody, loadInquiry, transitionInquiry, type ServiceContext } from "./shared";

const DAY_MS = 86_400_000;
const DEFAULT_LINK_DAYS = 14;
/** An identical customer message this soon after the last message is a double submit, not a new message. */
const DUPLICATE_WINDOW_SECONDS = 30;

export type StartDeps = { accessSecret: string; linkDays?: number };

export type StartedInquiry = { inquiryId: string; accessToken: string };

/**
 * A customer starts on a merchant's store page: the inquiry is created in NEW with their first message, and they get a signed
 * link that opens exactly that inquiry (valid for two weeks). The text is stored as written. The model is not involved.
 */
export async function startInquiry(db: SupabaseClient, deps: StartDeps, merchantSlug: string, firstMessage: unknown, ctx: ServiceContext): Promise<IntakeResult<StartedInquiry>> {
  const checked = checkMessageBody(firstMessage);
  if (!checked.ok) return { ok: false, code: checked.code };

  const merchant = await getPublicMerchant(db, merchantSlug);
  if (!merchant) return { ok: false, code: "NOT_FOUND" };
  const merchantRow = await db.from("merchants").select("id").eq("slug", merchant.slug).single();
  if (merchantRow.error) throw new Error(`load merchant: ${merchantRow.error.message}`);

  const inquiry = await db.from("inquiries").insert({ merchant_id: merchantRow.data.id }).select("id, access_version").single();
  if (inquiry.error) throw new Error(`create inquiry: ${inquiry.error.message}`);
  const inquiryId = inquiry.data.id as string;

  const message = await db.from("messages").insert({ inquiry_id: inquiryId, role: "customer", body: checked.text, created_at: ctx.now });
  if (message.error) {
    await db.from("inquiries").delete().eq("id", inquiryId); // never leave an inquiry with no message
    throw new Error(`store first message: ${message.error.message}`);
  }

  await auditIntake(db, ctx, `customer:${inquiryId}`, "intake.inquiry_started", inquiryId, { to: "NEW" });
  const accessToken = createCustomerLink({
    inquiryId,
    version: inquiry.data.access_version as number,
    expiresAt: new Date(Date.parse(ctx.now) + (deps.linkDays ?? DEFAULT_LINK_DAYS) * DAY_MS),
    secret: deps.accessSecret,
  });
  return { ok: true, value: { inquiryId, accessToken } };
}

export type PostedMessage = { messageId: string; duplicate: boolean };

/**
 * Stores one more customer message. It does not call the model: a turn is a separate step, so the message is kept even if
 * everything after it fails. A double submit (an identical message right after the last one, even five at once) stores one
 * message and returns its id. Past the cap on messages the message is refused and the inquiry goes to the merchant with a note.
 */
export async function postCustomerMessage(db: SupabaseClient, inquiryId: VerifiedInquiryId, body: unknown, ctx: ServiceContext): Promise<IntakeResult<PostedMessage>> {
  const checked = checkMessageBody(body);
  if (!checked.ok) return { ok: false, code: checked.code };
  const inquiry = await loadInquiry(db, inquiryId);
  if (!inquiry) return { ok: false, code: "INQUIRY_NOT_FOUND" };

  const stored = await db.rpc("intake_post_message", {
    p_inquiry_id: inquiryId,
    p_body: checked.text,
    p_now: ctx.now,
    p_max_messages: LIMITS.messages,
    p_window_seconds: DUPLICATE_WINDOW_SECONDS,
  });
  if (stored.error) throw new Error(`intake_post_message: ${stored.error.message}`);
  const out = stored.data as { ok: boolean; code?: IntakeErrorCode; duplicate?: boolean; message_id?: string };

  if (!out.ok && out.code === "LIMIT_REACHED") {
    const moved = await transitionInquiry(db, inquiryId, { type: "HAND_OFF" }, ctx, `customer:${inquiryId}`);
    if (moved.ok && moved.changed) {
      const note = await db.from("messages").insert({ inquiry_id: inquiryId, role: "system", body: "This conversation has reached its length limit, so the shop will take over from here.", created_at: ctx.now });
      if (note.error) throw new Error(`store note: ${note.error.message}`);
    }
    return { ok: false, code: "LIMIT_REACHED" };
  }
  if (!out.ok) return { ok: false, code: out.code ?? "INVALID_INPUT" };
  return { ok: true, value: { messageId: out.message_id!, duplicate: out.duplicate === true } };
}
