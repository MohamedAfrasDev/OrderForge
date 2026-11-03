// Helpers for database tests. They talk only to the LOCAL Supabase stack started with
// `supabase start`; credentials come from `supabase status`, never from .env.
import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readLocalSupabase } from "../support/local-supabase";

type LocalStack = { url: string; anonKey: string; serviceKey: string };

export function localStack(): LocalStack {
  const found = readLocalSupabase();
  if (!found.ok) throw new Error(found.reason);
  return found;
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };

export const serviceClient = (): SupabaseClient =>
  createClient(localStack().url, localStack().serviceKey, options);

export const anonClient = (): SupabaseClient =>
  createClient(localStack().url, localStack().anonKey, options);

type Result = { data?: unknown; error: { code?: string; message: string } | null };

/** Unwrap a supabase-js result, failing the test with the database message on error. `.single()` already errors when no row comes back. */
export function must<D>(result: { data: D; error: { message: string } | null }, label = "query"): NonNullable<D> {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data as NonNullable<D>;
}

/** The Postgres SQLSTATE reported by PostgREST, or "none" when the statement succeeded. */
export const codeOf = (result: Result): string => (result.error ? (result.error.code ?? "unknown") : "none");

export const SQLSTATE = {
  unique: "23505",
  check: "23514",
  raised: "P0001", // RAISE EXCEPTION from a trigger
  denied: "42501",
} as const;

export const randomHash = (): string => randomBytes(32).toString("hex");
export const unique = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;

export type Chain = {
  merchantId: string;
  inquiryId: string;
  quoteId: string;
  quoteHash: string;
  approvalId: string;
  purchaseId: string;
};

/** A merchant, inquiry, published quote, approval and purchase: what any payment-side row hangs off. */
export async function createChain(db: SupabaseClient, ownerUserId?: string): Promise<Chain> {
  const merchant = must(
    await db
      .from("merchants")
      .insert({ slug: unique("m"), name: "Test merchant", owner_user_id: ownerUserId ?? null })
      .select("id")
      .single(),
    "merchant",
  );
  const inquiry = must(
    await db.from("inquiries").insert({ merchant_id: merchant.id }).select("id").single(),
    "inquiry",
  );
  const quoteHash = randomHash();
  const quote = must(
    await db
      .from("quote_versions")
      .insert({
        inquiry_id: inquiry.id,
        version: 1,
        status: "PUBLISHED",
        lines: [],
        total_minor: 108000,
        quote_hash: quoteHash,
      })
      .select("id")
      .single(),
    "quote",
  );
  const approval = must(
    await db
      .from("approvals")
      .insert({ quote_version_id: quote.id, quote_hash: quoteHash, terms_text: "test terms" })
      .select("id")
      .single(),
    "approval",
  );
  const purchase = must(
    await db
      .from("purchases")
      .insert({
        merchant_id: merchant.id,
        inquiry_id: inquiry.id,
        quote_version_id: quote.id,
        approval_id: approval.id,
      })
      .select("id")
      .single(),
    "purchase",
  );
  return {
    merchantId: merchant.id,
    inquiryId: inquiry.id,
    quoteId: quote.id,
    quoteHash,
    approvalId: approval.id,
    purchaseId: purchase.id,
  };
}

export async function createMerchantUser(db: SupabaseClient): Promise<{ id: string; email: string; password: string }> {
  const email = `${unique("rls")}@test.invalid`;
  const password = randomUUID();
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (!created.data.user) throw new Error(`createUser: ${created.error?.message ?? "unknown error"}`);
  return { id: created.data.user.id, email, password };
}

export async function signedInClient(email: string, password: string): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign in: ${error.message}`);
  return client;
}

const NEEDS_ORDER = ["PROVIDER_CREATED", "APPROVED", "AUTHORIZE_IN_FLIGHT", "AUTHORIZED", "CAPTURE_IN_FLIGHT", "CAPTURED", "VOID_IN_FLIGHT", "VOIDED"];
const NEEDS_AUTHORIZATION = ["AUTHORIZED", "CAPTURE_IN_FLIGHT", "CAPTURED", "VOID_IN_FLIGHT", "VOIDED"];

/**
 * The evidence columns a payment attempt row must carry to be in `state` (an order id once past CREATED, an authorization
 * id once authorized, a capture id once captured, a reason for an exception). For tests that insert rows directly.
 */
export function attemptEvidence(state: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (NEEDS_ORDER.includes(state)) out.paypal_order_id = unique("ORDER");
  if (NEEDS_AUTHORIZATION.includes(state)) {
    out.authorization_id = unique("AUTH");
    out.authorized_at = "2026-11-03T10:00:00Z";
  }
  if (state === "CAPTURED") out.capture_id = unique("CAP");
  if (state === "EXCEPTION") out.exception_reason = "AMOUNT_MISMATCH";
  return out;
}
