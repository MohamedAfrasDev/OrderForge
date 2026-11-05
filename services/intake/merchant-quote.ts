import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { validateConfiguration, type Blocker } from "@/domain/catalog";
import { toCatalogRequirements } from "@/domain/intake";
import type { Condition } from "@/domain/quote";
import { cents, format } from "@/lib/money";
import { loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { createQuoteDraft } from "@/services/quote/create-draft";
import { publishQuote } from "@/services/quote/publish";
import { fieldsOf, type CustomerSpecField } from "./read";
import { appendMessage, auditIntake, latestRequirements, loadInquiry, type ServiceContext } from "./shared";

export type BuilderActor = { userId: string; merchantId: string };

/** The two notes the shop can attach. Fixed wording: the shop picks whether each applies, and never types a condition. */
export const NOTE_TEXT = {
  ARTWORK_ACCEPTANCE: "The shop will check your artwork and may ask for a changed file before making your boxes.",
  PRODUCTION_SLOT_CONFIRMATION: "The shop will confirm your production date once you have accepted this price.",
} as const;

export type BuilderProduct = { sku: string; name: string; unitPriceMinor: number; available: number };
export type BuilderSlot = { id: string; label: string; quantity: number; products: BuilderProduct[] };
export type QuoteBuilderView = {
  inquiryId: string;
  /** What the customer asked for, as the shop reads it on the request. */
  wishes: CustomerSpecField[];
  /** The confirmed number of boxes, or null when the customer never confirmed one. */
  quantity: number | null;
  slots: BuilderSlot[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function hasDraft(db: SupabaseClient, inquiryId: string): Promise<boolean> {
  const found = await db.from("quote_versions").select("id").eq("inquiry_id", inquiryId).eq("status", "DRAFT").limit(1);
  if (found.error) throw new Error(`check drafts: ${found.error.message}`);
  return (found.data ?? []).length > 0;
}

/**
 * What the Build a quote page shows: for an inquiry this shop owns and that waits for the shop, the customer's wishes, the confirmed quantity
 * and, per slot, the active products the template allows with name, unit price and what is available now. Anything else is null, including an
 * inquiry that already has a draft waiting in Quote review (that one is published from there).
 */
export async function quoteBuilderView(db: SupabaseClient, merchantId: string, inquiryId: string): Promise<QuoteBuilderView | null> {
  if (!UUID.test(inquiryId)) return null;
  const inquiry = await loadInquiry(db, inquiryId);
  if (!inquiry || inquiry.merchantId !== merchantId || inquiry.status !== "REVIEW_REQUIRED") return null;
  if (await hasDraft(db, inquiryId)) return null;

  const latest = await latestRequirements(db, inquiryId);
  const { catalog, stock } = await loadCatalogSnapshot(db, merchantId);
  const confirmed = latest?.stored.fields.boxCount;
  return {
    inquiryId,
    wishes: latest ? fieldsOf(latest.stored) : [],
    quantity: confirmed && confirmed.status === "confirmed" ? confirmed.value : null,
    slots: catalog.slots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      quantity: slot.quantity,
      products: slot.allowedSkus
        .map((sku) => catalog.products.find((p) => p.sku === sku))
        .filter((p): p is NonNullable<typeof p> => p !== undefined && p.active)
        .map((p) => ({ sku: p.sku, name: p.name, unitPriceMinor: Number(p.unitPriceMinor), available: stock[p.id] ?? 0 })),
    })),
  };
}

// strictObject: a price, discount, status or free-text condition has nowhere to go.
export const buildInputSchema = z.strictObject({
  quantity: z.number().int().min(1).max(100_000),
  selections: z.record(z.string().min(1).max(64), z.string().min(1).max(64)),
  notes: z.strictObject({ artwork: z.boolean(), productionSlot: z.boolean() }),
});
export type BuildInput = z.infer<typeof buildInputSchema>;

export type BuildResult =
  | { ok: true; value: { quoteId: string; boxCount: number; perBoxMinor: number; totalMinor: number } }
  | { ok: false; code: "NOT_FOUND" | "INVALID_INPUT" | "ILLEGAL_STATE" }
  | { ok: false; code: "CONFIGURATION_BLOCKED"; blockers: string[] };

/** A blocker in plain words, for the shop. */
export function describeBlocker(b: Blocker, nameOf: (sku: string) => string): string {
  switch (b.code) {
    case "UNKNOWN_PRODUCT":
    case "INACTIVE_PRODUCT":
      return `${nameOf(b.sku)} is not on sale.`;
    case "UNKNOWN_SLOT":
      return "That part of the box does not exist.";
    case "SLOT_NOT_FILLED":
      return "Every part of the box needs a product.";
    case "PRODUCT_NOT_ALLOWED_IN_SLOT":
      return `${nameOf(b.sku)} does not go in that part of the box.`;
    case "FOOD_NOT_ALLOWED":
      return `${nameOf(b.sku)} is food, and the customer asked for no food.`;
    case "INSUFFICIENT_STOCK":
      return `${nameOf(b.sku)}: ${b.needed} needed, ${b.available} available.`;
    case "OVER_BUDGET":
      return `${format(b.perBoxMinor)} per box is over the customer's budget of ${format(b.maxMinor)}.`;
    case "LOGO_NOT_COVERED":
      return "The customer wants a logo, and no part of this box carries one.";
    case "BELOW_MIN_QUANTITY":
      return `The shop's minimum is ${b.minimum} boxes.`;
    case "INVALID_QUANTITY":
      return "Enter a whole number of boxes.";
    case "UNSUPPORTED_DATE":
      return `The earliest pickup is ${b.earliest}, not ${b.requested}.`;
  }
}

const NOTE_TO_CUSTOMER = (boxCount: number, totalMinor: number, perBoxMinor: number) =>
  `The shop prepared your price: ${format(cents(totalMinor))} for ${boxCount} boxes (${format(cents(perBoxMinor))} per box). Review it and accept it when you're ready.`;

/**
 * The shop builds a price for a request that is with them. It takes only a quantity, one product per part of the box and which of the two fixed
 * notes apply. The catalog engine validates and prices it (the shop never types a price), the quote is published, and the customer gets one note.
 * The shop must own the inquiry (another shop's is NOT_FOUND) and it must be waiting for the shop (otherwise ILLEGAL_STATE). The inquiry is claimed
 * first with a compare-and-set, so a double submit makes one quote; the claim is given back if the price cannot be made.
 */
export async function buildQuoteForInquiry(db: SupabaseClient, actor: BuilderActor, inquiryId: unknown, input: unknown, ctx: ServiceContext): Promise<BuildResult> {
  if (typeof inquiryId !== "string" || !UUID.test(inquiryId)) return { ok: false, code: "INVALID_INPUT" };
  const parsed = buildInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  const { quantity, selections, notes } = parsed.data;

  const inquiry = await loadInquiry(db, inquiryId);
  if (!inquiry || inquiry.merchantId !== actor.merchantId) return { ok: false, code: "NOT_FOUND" };
  if (inquiry.status !== "REVIEW_REQUIRED" || (await hasDraft(db, inquiryId))) return { ok: false, code: "ILLEGAL_STATE" };

  // Check the box first, without claiming anything, so a blocked box changes nothing.
  const latest = await latestRequirements(db, inquiryId);
  const { catalog, stock } = await loadCatalogSnapshot(db, actor.merchantId);
  const requirements = latest ? toCatalogRequirements(latest.stored.fields) : { noFood: false, logoRequired: false };
  const check = validateConfiguration({ configuration: { boxCount: quantity, selections }, catalog, requirements, stock, today: ctx.now.slice(0, 10) });
  if (!check.ok) {
    const nameOf = (sku: string) => catalog.products.find((p) => p.sku === sku)?.name ?? sku;
    return { ok: false, code: "CONFIGURATION_BLOCKED", blockers: check.blockers.map((b) => describeBlocker(b, nameOf)) };
  }

  // Claim: only one of two simultaneous submits moves the inquiry on; the other is told it is no longer waiting.
  const claim = await db.from("inquiries").update({ status: "CONFIGURING" }).eq("id", inquiryId).eq("status", "REVIEW_REQUIRED").select("id");
  if (claim.error) throw new Error(`claim inquiry: ${claim.error.message}`);
  if ((claim.data ?? []).length === 0) return { ok: false, code: "ILLEGAL_STATE" };

  const giveBack = async (quoteId?: string) => {
    if (quoteId) await db.from("quote_versions").update({ status: "WITHDRAWN" }).eq("id", quoteId).eq("status", "DRAFT");
    await db.from("inquiries").update({ status: "REVIEW_REQUIRED" }).eq("id", inquiryId).eq("status", "CONFIGURING");
  };

  const conditions: Condition[] = [
    ...(notes.artwork ? [{ code: "ARTWORK_ACCEPTANCE" as const, text: NOTE_TEXT.ARTWORK_ACCEPTANCE }] : []),
    ...(notes.productionSlot ? [{ code: "PRODUCTION_SLOT_CONFIRMATION" as const, text: NOTE_TEXT.PRODUCTION_SLOT_CONFIRMATION }] : []),
  ];
  let quoteId: string | undefined;
  let live = false;
  try {
    const draft = await createQuoteDraft(db, { inquiryId, configuration: { boxCount: quantity, selections }, requirements, requirementVersionId: latest?.id ?? null, conditions }, ctx);
    if (!draft.ok) {
      await giveBack();
      return draft.code === "CONFIGURATION_BLOCKED"
        ? { ok: false, code: "CONFIGURATION_BLOCKED", blockers: (draft.blockers ?? []).map((b) => describeBlocker(b, (sku) => sku)) }
        : { ok: false, code: draft.code === "NOT_FOUND" ? "NOT_FOUND" : "INVALID_INPUT" };
    }
    quoteId = draft.value.quoteId;
    const published = await publishQuote(db, quoteId, { kind: "merchant", userId: actor.userId, merchantId: actor.merchantId }, ctx);
    if (!published.ok) {
      await giveBack(quoteId);
      return { ok: false, code: "ILLEGAL_STATE" };
    }
    live = true; // from here on the price exists and the customer can see it: nothing is given back
    const { priced } = draft.value;
    await auditIntake(db, ctx, `merchant:${actor.userId}`, "intake.quote_built", inquiryId, { quote_version: draft.value.version });
    await appendMessage(db, inquiryId, "system", NOTE_TO_CUSTOMER(priced.boxCount, priced.totalMinor, priced.perBoxMinor), ctx);
    return { ok: true, value: { quoteId, boxCount: priced.boxCount, perBoxMinor: priced.perBoxMinor, totalMinor: priced.totalMinor } };
  } catch (error) {
    if (!live) await giveBack(quoteId);
    throw error;
  }
}
