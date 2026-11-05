import type { SupabaseClient } from "@supabase/supabase-js";
import { FIELD_NAMES, quickRepliesFor, storedRequirementsSchema, type BlockingField, type FieldName, type FieldStatus, type Proposal, type QuickReplies, type StoredRequirements } from "@/domain/intake";
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
  /** The line the open question is about, and the tappable answers code offers for it (labels only, no ids). Both null when no question is open. */
  questionField: BlockingField | null;
  quick: QuickReplies | null;
  proposal: Proposal | null;
  /** Names for the SKUs the proposal mentions, so the screen never shows a code. */
  productNames: Record<string, string>;
  /** Each product's price in cents (the catalog's), so a suggested box can list what is in it. */
  productPrices: Record<string, number>;
  /** The box's slots by id: their plain label and how many of the product go in each box. */
  slots: Record<string, { label: string; quantity: number }>;
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
    fields: fieldsOf(latest.stored),
    question: latest.stored.question?.text ?? null,
    questionField: latest.stored.question?.field ?? null,
    quick: latest.stored.question ? quickRepliesFor({ field: latest.stored.question.field }, latest.stored.fields) : null,
    proposal: latest.stored.proposal,
    ...(await catalogFacts(db, inquiry.merchantId)),
  };
}

export function fieldsOf(stored: StoredRequirements): CustomerSpecField[] {
  return FIELD_NAMES.map((name) => {
    const f = stored.fields[name];
    return { name, label: LABELS[name], value: f.value, status: f.status, source: f.source === null ? null : f.source === "customer_edit" ? "edit" : "message" };
  });
}

/** What a screen needs to list a box in words. A shop whose catalog cannot be read gets nothing here, not a broken page (an item then reads "an item"). */
async function catalogFacts(db: SupabaseClient, merchantId: string): Promise<Pick<CustomerSpecView, "productNames" | "productPrices" | "slots">> {
  try {
    const { catalog } = await loadCatalogSnapshot(db, merchantId);
    return {
      productNames: Object.fromEntries(catalog.products.map((p) => [p.sku, p.name])),
      productPrices: Object.fromEntries(catalog.products.map((p) => [p.sku, p.unitPriceMinor])),
      slots: Object.fromEntries(catalog.slots.map((s) => [s.id, { label: s.label, quantity: s.quantity }])),
    };
  } catch (error) {
    if (error instanceof CatalogLoadError) return { productNames: {}, productPrices: {}, slots: {} };
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

export type MerchantInquiryMessage = { id: string; role: string; body: string; createdAt: string };

/** One handed-over inquiry as the merchant reads it: the whole conversation and the latest specification, in the customer's own terms. */
export type MerchantInquiry = {
  inquiryId: string;
  handedOverAt: string;
  messages: MerchantInquiryMessage[];
  fields: CustomerSpecField[];
  question: string | null;
};

/**
 * The merchant's inquiries waiting for them (`REVIEW_REQUIRED`), the most recently handed over first. Pass the merchant's own
 * session client: row level security then shows only their inquiries, even if another merchant's id were asked for.
 */
export async function listInquiriesForMerchant(db: SupabaseClient, merchantId: string, limit = 50): Promise<MerchantInquiry[]> {
  const inquiries = await db.from("inquiries").select("id, updated_at").eq("merchant_id", merchantId).eq("status", "REVIEW_REQUIRED").order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(limit);
  if (inquiries.error) throw new Error(`list inquiries: ${inquiries.error.message}`);
  const rows = (inquiries.data ?? []) as Array<{ id: string; updated_at: string }>;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const messages = await db.from("messages").select("id, inquiry_id, role, body, created_at").in("inquiry_id", ids).order("created_at", { ascending: true }).order("id", { ascending: true });
  if (messages.error) throw new Error(`list messages: ${messages.error.message}`);
  const versions = await db.from("requirement_versions").select("inquiry_id, version, requirements").in("inquiry_id", ids).order("version", { ascending: false });
  if (versions.error) throw new Error(`list requirements: ${versions.error.message}`);

  const latest = new Map<string, StoredRequirements>();
  for (const v of (versions.data ?? []) as Array<{ inquiry_id: string; requirements: unknown }>) {
    if (latest.has(v.inquiry_id)) continue;
    const parsed = storedRequirementsSchema.safeParse(v.requirements);
    if (parsed.success) latest.set(v.inquiry_id, parsed.data);
  }
  const all = (messages.data ?? []) as Array<{ id: string; inquiry_id: string; role: string; body: string; created_at: string }>;

  return rows.map((r) => {
    const stored = latest.get(r.id);
    return {
      inquiryId: r.id,
      handedOverAt: r.updated_at,
      messages: all.filter((m) => m.inquiry_id === r.id).map((m) => ({ id: m.id, role: m.role, body: m.body, createdAt: m.created_at })),
      fields: stored ? fieldsOf(stored) : [],
      question: stored?.question?.text ?? null,
    };
  });
}
