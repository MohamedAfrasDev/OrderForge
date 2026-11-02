// Customer-side reads. The only way to get a VerifiedInquiryId is authorizeCustomerLink(),
// and every read below requires one, so a query for another inquiry's data cannot be written
// by accident. These functions take the service-role client and filter on the verified id
// themselves, because that client bypasses row level security.
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyCustomerLink } from "@/lib/access/customer-link";

declare const verifiedBrand: unique symbol;
export type VerifiedInquiryId = string & { readonly [verifiedBrand]: "VerifiedInquiryId" };

export type CustomerInquiry = {
  id: VerifiedInquiryId;
  status: string;
  merchantName: string;
  createdAt: string;
};

export type CustomerMessage = { id: string; role: string; body: string; createdAt: string };

/** Deliberately says nothing about why access failed. */
export type CustomerAccess = { ok: true; inquiry: CustomerInquiry } | { ok: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const ASSET_BUCKET = "inquiry-assets";

type InquiryRow = {
  id: string;
  status: string;
  access_version: number;
  created_at: string;
  merchants: { name: string } | { name: string }[] | null;
};

/**
 * 1. Check signature and expiry locally (no database access for forged or stale tokens).
 * 2. Load the inquiry named by the token and compare its access_version (revocation).
 */
export async function authorizeCustomerLink(
  db: SupabaseClient,
  token: string,
  options: { secret: string; now?: Date },
): Promise<CustomerAccess> {
  const signed = verifyCustomerLink(token, options);
  if (!signed.ok || !UUID.test(signed.inquiryId)) return { ok: false };

  const { data } = await db
    .from("inquiries")
    .select("id, status, access_version, created_at, merchants(name)")
    .eq("id", signed.inquiryId)
    .maybeSingle<InquiryRow>();
  if (!data || data.access_version !== signed.version) return { ok: false };

  const merchant = Array.isArray(data.merchants) ? data.merchants[0] : data.merchants;
  return {
    ok: true,
    inquiry: {
      id: data.id as VerifiedInquiryId,
      status: data.status,
      merchantName: merchant?.name ?? "",
      createdAt: data.created_at,
    },
  };
}

export async function getCustomerMessages(
  db: SupabaseClient,
  inquiryId: VerifiedInquiryId,
): Promise<CustomerMessage[]> {
  const { data } = await db
    .from("messages")
    .select("id, role, body, created_at")
    .eq("inquiry_id", inquiryId)
    .order("created_at", { ascending: true });
  return (data ?? []).map((m) => ({ id: m.id, role: m.role, body: m.body, createdAt: m.created_at }));
}

/** An asset, but only if it belongs to the verified inquiry. */
export async function findOwnedAsset(
  db: SupabaseClient,
  inquiryId: VerifiedInquiryId,
  assetId: string,
): Promise<{ id: string; storagePath: string; mimeType: string } | null> {
  if (!UUID.test(assetId)) return null;
  const { data } = await db
    .from("assets")
    .select("id, storage_path, mime_type")
    .eq("id", assetId)
    .eq("inquiry_id", inquiryId)
    .maybeSingle();
  return data ? { id: data.id, storagePath: data.storage_path, mimeType: data.mime_type } : null;
}

/**
 * Short-lived signed URL for a private Storage object, minted only after the ownership check.
 * Not exercised by tests yet: CI's Supabase stack runs without Storage, and the bucket is created
 * by the module that adds uploads (ai-intake).
 */
export async function signedAssetUrl(
  db: SupabaseClient,
  inquiryId: VerifiedInquiryId,
  assetId: string,
  expiresInSeconds = 60,
): Promise<string | null> {
  const asset = await findOwnedAsset(db, inquiryId, assetId);
  if (!asset) return null;
  const { data, error } = await db.storage.from(ASSET_BUCKET).createSignedUrl(asset.storagePath, expiresInSeconds);
  return error || !data ? null : data.signedUrl;
}

/** Public storefront fields only; nothing about the merchant's account. */
export async function getPublicMerchant(
  db: SupabaseClient,
  slug: string,
): Promise<{ slug: string; name: string } | null> {
  if (!SLUG.test(slug) || slug.length > 64) return null;
  const { data } = await db.from("merchants").select("slug, name").eq("slug", slug).maybeSingle();
  return data ? { slug: data.slug, name: data.name } : null;
}
