import type { SupabaseClient } from "@supabase/supabase-js";
import type { VerifiedInquiryId } from "@/lib/access/inquiry-reads";

type Embedded<T> = T | T[] | null;
const one = <T>(value: Embedded<T>): T | null => (Array.isArray(value) ? (value[0] ?? null) : value);

/** After this long an authorization may be less reliable to capture (the brief's honor period). */
export const HONOR_PERIOD_DAYS = 3;

/**
 * What a customer may know about the payment on their accepted quote. Deliberately coarse: no ids, amounts or internal
 * states. `canPay` is true when starting (or starting again) is possible.
 */
export type CustomerPaymentView = {
  status: "NONE" | "PAYING" | "WAITING_MERCHANT" | "CHECKING" | "PAID" | "DECLINED" | "FAILED";
  canPay: boolean;
};

type AttemptEmbed = { state: string; created_at: string };
type DecisionEmbed = { decision: string };

/**
 * The payment behind the verified inquiry's ACCEPTED quote, or null when the inquiry has no accepted quote.
 * Anything that needs a person (an exception, an outcome in doubt, a decision being carried out) reads as CHECKING.
 */
export async function paymentStatusForCustomer(db: SupabaseClient, inquiryId: VerifiedInquiryId): Promise<CustomerPaymentView | null> {
  const quote = await db.from("quote_versions").select("id").eq("inquiry_id", inquiryId).eq("status", "ACCEPTED").maybeSingle();
  if (quote.error) throw new Error(`read accepted quote: ${quote.error.message}`);
  if (!quote.data) return null;

  const purchase = await db
    .from("purchases")
    .select("id, payment_attempts(state, created_at), merchant_decisions(decision)")
    .eq("quote_version_id", quote.data.id as string)
    .maybeSingle();
  if (purchase.error) throw new Error(`read purchase: ${purchase.error.message}`);
  if (!purchase.data) return null;

  const row = purchase.data as unknown as { payment_attempts: AttemptEmbed[] | null; merchant_decisions: Embedded<DecisionEmbed> };
  const attempts = [...(row.payment_attempts ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const latest = attempts[0];
  const decision = one(row.merchant_decisions)?.decision ?? null;
  if (!latest) return { status: "NONE", canPay: true };

  switch (latest.state) {
    case "CREATED":
    case "PROVIDER_CREATED":
    case "APPROVED":
      return { status: "PAYING", canPay: true };
    case "AUTHORIZED":
      return decision === "pending" || decision === null ? { status: "WAITING_MERCHANT", canPay: false } : { status: "CHECKING", canPay: false };
    case "CAPTURED":
      return { status: "PAID", canPay: false };
    case "VOIDED":
      return { status: "DECLINED", canPay: false };
    case "FAILED":
    case "EXPIRED":
      return { status: "FAILED", canPay: true };
    default:
      return { status: "CHECKING", canPay: false };
  }
}

/** The accepted quote's purchase for a verified inquiry, so the page never takes a purchase id from the browser. */
export async function purchaseIdForCustomer(db: SupabaseClient, inquiryId: VerifiedInquiryId): Promise<string | null> {
  const quote = await db.from("quote_versions").select("id").eq("inquiry_id", inquiryId).eq("status", "ACCEPTED").maybeSingle();
  if (quote.error) throw new Error(`read accepted quote: ${quote.error.message}`);
  if (!quote.data) return null;
  const purchase = await db.from("purchases").select("id").eq("quote_version_id", quote.data.id as string).eq("inquiry_id", inquiryId).maybeSingle();
  if (purchase.error) throw new Error(`read purchase: ${purchase.error.message}`);
  return (purchase.data?.id as string | undefined) ?? null;
}

/** The one question fulfillment asks: has this purchase been paid? True only for a verified capture. */
export async function isPurchasePaid(db: SupabaseClient, purchaseId: string): Promise<boolean> {
  const found = await db.from("payment_attempts").select("id").eq("purchase_id", purchaseId).eq("state", "CAPTURED").limit(1);
  if (found.error) throw new Error(`read payment: ${found.error.message}`);
  return (found.data ?? []).length > 0;
}

export type DecisionCondition = { code: string; text: string; needsConfirmation: boolean };
export type DecisionRow = {
  purchaseId: string;
  inquiryId: string;
  quoteVersion: number;
  totalMinor: number;
  state: string;
  decision: string | null;
  exceptionReason: string | null;
  conditions: DecisionCondition[];
  authorizedAt: string | null;
  authorizationExpiresAt: string | null;
  /** The authorization is old enough that capture may be less reliable. Capture is still attempted until PayPal refuses. */
  honorWarning: boolean;
  /** waiting: your decision is needed. checking: a step is being carried out or confirmed. exception: needs a person. */
  section: "waiting" | "checking" | "exception";
};

type QueryRow = {
  id: string;
  inquiry_id: string;
  merchant_id: string;
  quote_versions: Embedded<{ version: number; total_minor: number; pending_conditions: Array<{ code?: string; text?: string }> | null }>;
  merchant_decisions: Embedded<{ decision: string }>;
  payment_attempts: Array<{
    state: string;
    created_at: string;
    exception_reason: string | null;
    authorized_at: string | null;
    authorization_expires_at: string | null;
  }> | null;
};

const NEEDS_CONFIRMATION = new Set(["PRODUCTION_SLOT_CONFIRMATION", "ARTWORK_ACCEPTANCE"]);
const CHECKING_STATES = new Set(["AUTHORIZE_IN_FLIGHT", "CAPTURE_IN_FLIGHT", "VOID_IN_FLIGHT", "OUTCOME_UNKNOWN"]);

/**
 * The merchant's payments that need them or need watching: authorized orders waiting for a decision, orders being
 * carried out or checked, and financial exceptions (exceptions first). Pass the merchant's own session client so row
 * level security applies: another merchant's payments stay invisible even if their id were passed.
 */
export async function listDecisionsForMerchant(db: SupabaseClient, merchantId: string, now: string, limit = 100): Promise<DecisionRow[]> {
  const found = await db
    .from("purchases")
    .select(
      "id, inquiry_id, merchant_id, quote_versions(version, total_minor, pending_conditions), merchant_decisions(decision), payment_attempts(state, created_at, exception_reason, authorized_at, authorization_expires_at)",
    )
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (found.error) throw new Error(`list decisions: ${found.error.message}`);

  const rows: DecisionRow[] = [];
  for (const p of (found.data ?? []) as unknown as QueryRow[]) {
    const attempts = [...(p.payment_attempts ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const latest = attempts[0];
    if (!latest) continue;
    const quote = one(p.quote_versions);
    if (!quote) continue;
    const decision = one(p.merchant_decisions)?.decision ?? null;

    let section: DecisionRow["section"] | null = null;
    if (latest.state === "EXCEPTION") section = "exception";
    else if (latest.state === "AUTHORIZED") section = decision === "pending" || decision === null ? "waiting" : "checking";
    else if (CHECKING_STATES.has(latest.state)) section = "checking";
    if (!section) continue;

    const authorizedAt = latest.authorized_at ? new Date(latest.authorized_at).toISOString() : null;
    rows.push({
      purchaseId: p.id,
      inquiryId: p.inquiry_id,
      quoteVersion: quote.version,
      totalMinor: Number(quote.total_minor),
      state: latest.state,
      decision,
      exceptionReason: latest.exception_reason,
      conditions: (quote.pending_conditions ?? [])
        .filter((c): c is { code: string; text: string } => typeof c.code === "string" && typeof c.text === "string")
        .map((c) => ({ code: c.code, text: c.text, needsConfirmation: NEEDS_CONFIRMATION.has(c.code) })),
      authorizedAt,
      authorizationExpiresAt: latest.authorization_expires_at ? new Date(latest.authorization_expires_at).toISOString() : null,
      honorWarning: authorizedAt !== null && Date.parse(now) - Date.parse(authorizedAt) >= HONOR_PERIOD_DAYS * 86_400_000,
      section,
    });
  }

  const order = { exception: 0, waiting: 1, checking: 2 } as const;
  return rows.sort((a, b) => order[a.section] - order[b.section]);
}
