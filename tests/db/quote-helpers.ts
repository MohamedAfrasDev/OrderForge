import type { SupabaseClient } from "@supabase/supabase-js";
import { must, randomHash, unique } from "./helpers";

export type RpcResult = {
  ok: boolean;
  code?: string;
  quote_id?: string;
  version?: number;
  approval_id?: string;
  purchase_id?: string;
  already?: boolean;
  superseded_quote_id?: string | null;
  invalidated_purchase_ids?: string[];
};

export async function rpc(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  return must(await db.rpc(fn, args), fn) as RpcResult;
}

export async function newInquiry(db: SupabaseClient): Promise<{ merchantId: string; inquiryId: string }> {
  const merchant = must(
    await db.from("merchants").insert({ slug: unique("m"), name: "Quote test merchant" }).select("id").single(),
    "merchant",
  );
  const inquiry = must(await db.from("inquiries").insert({ merchant_id: merchant.id }).select("id").single(), "inquiry");
  return { merchantId: merchant.id, inquiryId: inquiry.id };
}

export const draftLines = { boxCount: 30, perBoxMinor: 3600, lines: [] as unknown[] };

export async function newDraft(db: SupabaseClient, inquiryId: string): Promise<{ quoteId: string; version: number }> {
  const r = await rpc(db, "create_quote_draft", {
    p_inquiry_id: inquiryId,
    p_requirement_version_id: null,
    p_lines: draftLines,
    p_total_minor: 108000,
    p_pending_conditions: [],
  });
  if (!r.ok) throw new Error(`create_quote_draft: ${r.code}`);
  return { quoteId: r.quote_id!, version: r.version! };
}

export const NOW = "2026-11-03T10:00:00.000Z";

export async function publish(db: SupabaseClient, quoteId: string, hash = randomHash(), now = NOW) {
  const r = await rpc(db, "publish_quote", { p_quote_id: quoteId, p_hash: hash, p_now: now });
  return { ...r, hash };
}

export async function accept(
  db: SupabaseClient,
  quoteId: string,
  hash: string,
  now = NOW,
  validityHours = 72,
): Promise<RpcResult> {
  return rpc(db, "accept_quote", {
    p_quote_id: quoteId,
    p_expected_hash: hash,
    p_terms_text: "test terms",
    p_now: now,
    p_validity_hours: validityHours,
  });
}

export async function statusOf(db: SupabaseClient, quoteId: string): Promise<string> {
  return must(await db.from("quote_versions").select("status").eq("id", quoteId).single(), "status").status as string;
}
