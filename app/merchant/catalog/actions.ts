"use server";

import { refresh } from "next/cache";
import { parseDollars, parseWholeNumber } from "@/domain/catalog-edit";
import { requireMerchant } from "@/lib/access/require-merchant";
import { newCorrelationId } from "@/lib/correlation";
import { createAdminClient } from "@/lib/supabase/admin";
import { addProduct, catalogEditMessage, editProduct } from "@/services/catalog/edit";

export type EditOutcome = { ok: true } | { ok: false; message: string };
export type AddState = { status: "idle" } | { status: "error"; message: string } | { status: "done"; name: string };

const context = () => ({ now: new Date().toISOString(), correlationId: newCorrelationId() });

// Server actions are public endpoints: the shop's session is verified on every call, and the service checks that the product is this shop's.
// Only the product id and the changed values come from the browser. The patch is passed on as is: the service's strict schema decides.
export async function editProductAction(productId: string, patch: Record<string, unknown>): Promise<EditOutcome> {
  const { user, merchant } = await requireMerchant();
  const result = await editProduct(createAdminClient(), { userId: user.id, merchantId: merchant.id }, productId, patch, context());
  if (!result.ok) return { ok: false, message: catalogEditMessage(result.code, result.detail) };
  refresh();
  return { ok: true };
}

export async function addProductAction(_previous: AddState, formData: FormData): Promise<AddState> {
  const { user, merchant } = await requireMerchant();
  const priceMinor = parseDollars(formData.get("price"));
  const onHand = parseWholeNumber(formData.get("onHand"));
  if (priceMinor === null) return { status: "error", message: "Enter the price in dollars and cents, like 12.50." };
  if (onHand === null) return { status: "error", message: "Enter how many you have as a whole number, like 40." };
  const slotIds = formData.getAll("slot").filter((v): v is string => typeof v === "string");
  if (slotIds.length === 0) return { status: "error", message: "Choose at least one part of the box this product can go in." };

  const sku = formData.get("sku");
  const result = await addProduct(
    createAdminClient(),
    { userId: user.id, merchantId: merchant.id },
    { sku: typeof sku === "string" ? sku.trim() : sku, name: formData.get("name"), category: formData.get("category"), priceMinor, isFood: formData.get("isFood") === "on", onHand, slotIds },
    context(),
  );
  if (!result.ok) return { status: "error", message: catalogEditMessage(result.code, result.detail) };
  refresh();
  return { status: "done", name: String(formData.get("name")).trim() };
}
