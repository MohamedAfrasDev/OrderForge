import type { SupabaseClient } from "@supabase/supabase-js";
import { FIELD_NAMES, type FieldName, type FieldStatus, type Proposal } from "@/domain/intake";
import type { VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { CatalogLoadError, loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { latestRequirements, loadInquiry } from "./shared";

const LABELS: Record<FieldName, string> = {
  boxCount: "Number of boxes",
  noFood: "No food",
  logoRequired: "Company logo",
  maxPricePerBoxMinor: "Budget per box",
  requestedPickupDate: "Pickup date",
  preferences: "Preferences",
};

export type CustomerSpecField = {
  name: FieldName;
  label: string;
  value: unknown;
  status: FieldStatus;
  /** Where it came from, in plain terms: a message, the customer's own edit, or nowhere (not specified). No ids. */
  source: "message" | "edit" | null;
};

/**
 * What the customer sees of the specification: the fields in a fixed order with how sure we are and where each came from, the
 * one question the agent is waiting on, and what it proposed (options carry code's prices). No ids and no model internals.
 */
export type CustomerSpecView = {
  version: number;
  inquiryStatus: string;
  fields: CustomerSpecField[];
  question: string | null;
  proposal: Proposal | null;
  /** Names for the SKUs the proposal mentions, so the screen never shows a code. */
  productNames: Record<string, string>;
};

/** The latest version of the verified inquiry's specification, or null until something has been recorded. */
export async function requirementsForCustomer(db: SupabaseClient, inquiryId: VerifiedInquiryId): Promise<CustomerSpecView | null> {
  const inquiry = await loadInquiry(db, inquiryId);
  if (!inquiry) return null;
  const latest = await latestRequirements(db, inquiryId);
  if (!latest) return null;

  return {
    version: latest.version,
    inquiryStatus: inquiry.status,
    fields: FIELD_NAMES.map((name) => {
      const f = latest.stored.fields[name];
      return { name, label: LABELS[name], value: f.value, status: f.status, source: f.source === null ? null : f.source === "customer_edit" ? "edit" : "message" };
    }),
    question: latest.stored.question?.text ?? null,
    proposal: latest.stored.proposal,
    productNames: await productNames(db, inquiry.merchantId),
  };
}

/** A merchant whose catalog cannot be read gets no names, not a broken page: the screen then says "an item". */
async function productNames(db: SupabaseClient, merchantId: string): Promise<Record<string, string>> {
  try {
    return Object.fromEntries((await loadCatalogSnapshot(db, merchantId)).catalog.products.map((p) => [p.sku, p.name]));
  } catch (error) {
    if (error instanceof CatalogLoadError) return {};
    throw error;
  }
}

/** The newest customer message nobody has answered yet (the assistant failed, or has not run): what "Try again" re-runs. */
export async function unansweredMessageId(db: SupabaseClient, inquiryId: VerifiedInquiryId): Promise<string | null> {
  const rows = await db.from("messages").select("id, role, reply_to").eq("inquiry_id", inquiryId).in("role", ["customer", "assistant"]).order("created_at", { ascending: false }).order("id", { ascending: false });
  if (rows.error) throw new Error(`load messages: ${rows.error.message}`);
  const data = (rows.data ?? []) as Array<{ id: string; role: string; reply_to: string | null }>;
  const answered = new Set(data.filter((m) => m.reply_to !== null).map((m) => m.reply_to));
  return data.find((m) => m.role === "customer" && !answered.has(m.id))?.id ?? null;
}
