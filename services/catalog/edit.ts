import type { SupabaseClient } from "@supabase/supabase-js";
import { boxTemplateRuleSchema } from "@/domain/catalog";
import {
  addProductSchema,
  checkDeactivation,
  checkNewProductSlots,
  checkStockChange,
  editProductSchema,
  withSkuInSlots,
  type EditableField,
  type TemplateSlot,
} from "@/domain/catalog-edit";
import { audit } from "@/lib/audit";
import { auditInsertFor, type ServiceContext } from "@/services/reservation/shared";

export type CatalogActor = { userId: string; merchantId: string };

export type CatalogEditCode = "NOT_FOUND" | "INVALID_INPUT" | "DUPLICATE_SKU" | "STOCK_HELD" | "LAST_IN_SLOT";
export type CatalogEditResult<T> = { ok: true; value: T } | { ok: false; code: CatalogEditCode; detail?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = "23505";
const TEMPLATE_ATTEMPTS = 4;

type ProductRow = { id: string; merchant_id: string; sku: string; name: string; category: string; unit_price_minor: number; is_food: boolean; active: boolean };

async function loadProduct(db: SupabaseClient, productId: string): Promise<ProductRow | null> {
  const found = await db.from("products").select("id, merchant_id, sku, name, category, unit_price_minor, is_food, active").eq("id", productId).maybeSingle();
  if (found.error) throw new Error(`load product: ${found.error.message}`);
  return (found.data as ProductRow | null) ?? null;
}

async function loadTemplate(db: SupabaseClient, merchantId: string): Promise<{ slots: Array<TemplateSlot & { quantity: number; customization?: "logo" }> } | null> {
  const found = await db.from("business_rules").select("value").eq("merchant_id", merchantId).eq("key", "box_template").maybeSingle();
  if (found.error) throw new Error(`load template: ${found.error.message}`);
  if (!found.data) return null;
  const parsed = boxTemplateRuleSchema.safeParse(found.data.value);
  if (!parsed.success) throw new Error("the box template is not in the expected shape");
  return parsed.data;
}

/**
 * Edits one product of the shop. The shop must own it (another shop's product is NOT_FOUND, like one that does not exist) and the patch is a
 * strict schema, so there is no way to change the SKU, the owner, or what is reserved. A product cannot be switched off while it is the last
 * active one of a part of the box (LAST_IN_SLOT), and stock on hand cannot go below what is held (STOCK_HELD). Only catalog rows change:
 * quotes keep the lines and prices they were made with, so an edit never changes a published or an accepted quote.
 */
export async function editProduct(db: SupabaseClient, actor: CatalogActor, productId: unknown, patch: unknown, ctx: ServiceContext): Promise<CatalogEditResult<{ productId: string; changed: EditableField[] }>> {
  if (typeof productId !== "string" || !UUID.test(productId)) return { ok: false, code: "INVALID_INPUT" };
  const parsed = editProductSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  const edit = parsed.data;

  const product = await loadProduct(db, productId);
  if (!product || product.merchant_id !== actor.merchantId) return { ok: false, code: "NOT_FOUND" };

  const stockRow = await db.from("stock").select("on_hand, reserved").eq("product_id", productId).maybeSingle();
  if (stockRow.error) throw new Error(`load stock: ${stockRow.error.message}`);
  const onHandNow = (stockRow.data?.on_hand as number | undefined) ?? 0;

  const set: Record<string, unknown> = {};
  const changed: EditableField[] = [];
  const note = (field: EditableField, differs: boolean, column?: string, value?: unknown) => {
    if (!differs) return;
    changed.push(field);
    if (column) set[column] = value;
  };
  note("name", edit.name !== undefined && edit.name !== product.name, "name", edit.name);
  note("category", edit.category !== undefined && edit.category !== product.category, "category", edit.category);
  note("priceMinor", edit.priceMinor !== undefined && edit.priceMinor !== Number(product.unit_price_minor), "unit_price_minor", edit.priceMinor);
  note("isFood", edit.isFood !== undefined && edit.isFood !== product.is_food, "is_food", edit.isFood);
  note("active", edit.active !== undefined && edit.active !== product.active, "active", edit.active);
  const stockChanges = edit.onHand !== undefined && edit.onHand !== onHandNow;
  note("onHand", stockChanges);
  if (changed.length === 0) return { ok: true, value: { productId, changed } };

  if (edit.active === false && product.active) {
    const template = await loadTemplate(db, actor.merchantId);
    const all = await db.from("products").select("sku, active").eq("merchant_id", actor.merchantId);
    if (all.error) throw new Error(`load products: ${all.error.message}`);
    const verdict = checkDeactivation(template?.slots ?? [], (all.data ?? []) as Array<{ sku: string; active: boolean }>, product.sku);
    if (!verdict.ok) return { ok: false, code: "LAST_IN_SLOT", detail: verdict.slotLabels.join(", ") };
  }

  if (stockChanges) {
    const held = (stockRow.data?.reserved as number | undefined) ?? 0;
    const verdict = checkStockChange(edit.onHand!, held);
    if (!verdict.ok) return { ok: false, code: "STOCK_HELD", detail: String(verdict.held) };
    // One statement checks and writes: if a customer's hold landed since the read above, no row matches and nothing changes.
    const written = stockRow.data
      ? await db.from("stock").update({ on_hand: edit.onHand }).eq("product_id", productId).lte("reserved", edit.onHand!).select("product_id")
      : await db.from("stock").insert({ product_id: productId, on_hand: edit.onHand, reserved: 0 }).select("product_id");
    if (written.error) {
      if (written.error.message.includes("reserved") || written.error.code === "23514") return { ok: false, code: "STOCK_HELD" };
      throw new Error(`write stock: ${written.error.message}`);
    }
    if ((written.data ?? []).length === 0) return { ok: false, code: "STOCK_HELD" };
  }

  if (Object.keys(set).length > 0) {
    const updated = await db.from("products").update(set).eq("id", productId).eq("merchant_id", actor.merchantId).select("id");
    if (updated.error) throw new Error(`update product: ${updated.error.message}`);
  }

  await audit(auditInsertFor(db), { actor: `merchant:${actor.userId}`, action: "catalog.product_edited", entity: "product", entityId: productId, correlationId: ctx.correlationId, data: { fields: changed } });
  return { ok: true, value: { productId, changed } };
}

/**
 * Adds a product to the shop's catalog. The SKU must be new for this shop; the product starts active with its stock; and it must go in at least
 * one part of the box. The box template is written last: if anything fails before that, the product exists but is in no box, so nothing can
 * be sold that was half set up, and the template never names a product that is missing.
 */
export async function addProduct(db: SupabaseClient, actor: CatalogActor, input: unknown, ctx: ServiceContext): Promise<CatalogEditResult<{ productId: string }>> {
  const parsed = addProductSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  const add = parsed.data;

  const template = await loadTemplate(db, actor.merchantId);
  if (!template) return { ok: false, code: "INVALID_INPUT", detail: "this shop has no box template" };
  const placed = checkNewProductSlots(add.slotIds, template.slots);
  if (!placed.ok) return { ok: false, code: "INVALID_INPUT", detail: placed.reason };

  const same = await db.from("products").select("id").eq("merchant_id", actor.merchantId).eq("sku", add.sku).limit(1);
  if (same.error) throw new Error(`check sku: ${same.error.message}`);
  if ((same.data ?? []).length > 0) return { ok: false, code: "DUPLICATE_SKU" };

  const inserted = await db
    .from("products")
    .insert({ merchant_id: actor.merchantId, sku: add.sku, name: add.name, category: add.category, unit_price_minor: add.priceMinor, is_food: add.isFood, active: true })
    .select("id")
    .single();
  if (inserted.error) {
    if (inserted.error.code === UNIQUE_VIOLATION) return { ok: false, code: "DUPLICATE_SKU" };
    throw new Error(`insert product: ${inserted.error.message}`);
  }
  const productId = inserted.data.id as string;

  const stocked = await db.from("stock").insert({ product_id: productId, on_hand: add.onHand, reserved: 0 });
  if (stocked.error) {
    await db.from("products").delete().eq("id", productId); // nothing refers to it yet
    throw new Error(`insert stock: ${stocked.error.message}`);
  }

  // The template last. Two adds at once could each write a template without the other's product, so after writing, the template is read back and
  // the write is repeated on the newest version until this product is in every part asked for.
  for (let attempt = 0; attempt < TEMPLATE_ATTEMPTS; attempt++) {
    const current = await loadTemplate(db, actor.merchantId);
    if (!current) throw new Error("the box template disappeared");
    const next = { slots: withSkuInSlots(current.slots, add.sku, add.slotIds) };
    const written = await db.from("business_rules").update({ value: next }).eq("merchant_id", actor.merchantId).eq("key", "box_template");
    if (written.error) throw new Error(`write template: ${written.error.message}`);
    const check = await loadTemplate(db, actor.merchantId);
    const there = check?.slots.filter((s) => add.slotIds.includes(s.id)).every((s) => s.allowedSkus.includes(add.sku));
    if (there) {
      await audit(auditInsertFor(db), { actor: `merchant:${actor.userId}`, action: "catalog.product_added", entity: "product", entityId: productId, correlationId: ctx.correlationId, data: { fields: ["sku", "name", "category", "priceMinor", "isFood", "onHand", "slotIds"] } });
      return { ok: true, value: { productId } };
    }
  }
  throw new Error("could not place the new product in the box template");
}

/** The shop's words for a refusal. */
export function catalogEditMessage(code: CatalogEditCode, detail?: string): string {
  switch (code) {
    case "NOT_FOUND":
      return "We could not find that product.";
    case "INVALID_INPUT":
      return "Check what you entered: a name, a category, a price in dollars and cents, and a stock count that is a whole number.";
    case "DUPLICATE_SKU":
      return "You already have a product with that code. Choose a different code.";
    case "STOCK_HELD":
      return detail ? `Customers are holding ${detail} of these, so stock cannot go below ${detail}.` : "Customers are holding more than that, so stock cannot go that low.";
    case "LAST_IN_SLOT":
      return detail ? `This is the only product on sale for ${detail}. Add another one first, or boxes could not be made.` : "This is the only product on sale for part of the box. Add another one first.";
  }
}
