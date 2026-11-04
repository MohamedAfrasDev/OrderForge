import type { SupabaseClient } from "@supabase/supabase-js";
import { createCustomerLink } from "@/lib/access/customer-link";
import { authorizeCustomerLink, type VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { must, unique } from "./helpers";

export const SECRET = "db-test-secret-with-enough-length";
export const NOW = "2026-11-04T10:00:00.000Z";
export const ctx = { now: NOW, correlationId: "corr-intake-test" };
export const deps = { accessSecret: SECRET };

/** A merchant of its own with a store slug, so inquiries of different tests never mix. */
export async function newMerchant(db: SupabaseClient): Promise<{ id: string; slug: string }> {
  const slug = unique("shop").toLowerCase();
  const merchant = must(await db.from("merchants").insert({ slug, name: "Intake test merchant" }).select("id").single(), "merchant");
  return { id: merchant.id as string, slug };
}

/** The verified id the customer entry points require, made the same way a real link is checked. */
export async function verifiedFor(db: SupabaseClient, inquiryId: string, version = 1): Promise<VerifiedInquiryId> {
  const token = createCustomerLink({ inquiryId, version, expiresAt: new Date("2030-01-01T00:00:00Z"), secret: SECRET });
  const access = await authorizeCustomerLink(db, token, { secret: SECRET, now: new Date(NOW) });
  if (!access.ok) throw new Error("expected a valid link");
  return access.inquiry.id;
}

/** An inquiry with `count` messages already in it (customer and assistant alternating). */
export async function inquiryWithMessages(db: SupabaseClient, merchantId: string, count: number): Promise<string> {
  const inquiry = must(await db.from("inquiries").insert({ merchant_id: merchantId }).select("id").single(), "inquiry");
  const rows = Array.from({ length: count }, (_, i) => ({ inquiry_id: inquiry.id, role: i % 2 === 0 ? "customer" : "assistant", body: `message ${i}`, created_at: new Date(Date.parse(NOW) - (count - i) * 60_000).toISOString() }));
  if (rows.length > 0) must(await db.from("messages").insert(rows), "messages");
  return inquiry.id as string;
}

export const messagesOf = async (db: SupabaseClient, inquiryId: string) =>
  must(await db.from("messages").select("id, role, body, reply_to").eq("inquiry_id", inquiryId).order("created_at")) as Array<{ id: string; role: string; body: string; reply_to: string | null }>;

export const versionsOf = async (db: SupabaseClient, inquiryId: string) =>
  must(await db.from("requirement_versions").select("version, requirements, source_message_id").eq("inquiry_id", inquiryId).order("version")) as Array<{
    version: number;
    requirements: { fields: Record<string, { value: unknown; status: string; source: string | null }> };
    source_message_id: string | null;
  }>;
