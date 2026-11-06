// The second demo shop (Demo Event Kits) made ready for the browser run, in the LOCAL database only. Its own owner login is a test
// credential for the local stack (the address cannot receive mail), distinct from the first shop's, so the two shops never share an owner.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { boxTemplate2, merchant2, products2, stock2 } from "../supabase/seed/fixtures";
import type { Shop } from "./journey-support";

export const KIT_BOTTLE_STOCK = 40;

/**
 * The second shop's rows, made only if they are missing. It changes nothing that exists (no stock reset, no login), so a spec that only needs the
 * shop to be there can call it while another spec is using the shop.
 */
export async function ensureKitShop(db: SupabaseClient): Promise<{ merchantId: string; slug: string; name: string }> {
  const made = await db.from("merchants").upsert({ slug: merchant2.slug, name: merchant2.name }, { onConflict: "slug", ignoreDuplicates: true });
  if (made.error) throw new Error(`merchant: ${made.error.message}`);
  const merchant = await db.from("merchants").select("id, name").eq("slug", merchant2.slug).single();
  if (merchant.error) throw new Error(`merchant: ${merchant.error.message}`);
  const merchantId = merchant.data.id as string;

  const have = await db.from("products").select("id").eq("merchant_id", merchantId);
  if ((have.data ?? []).length === 0) {
    const ids = new Map(products2.map((p) => [p.id, randomUUID()]));
    const inserted = await db.from("products").upsert(products2.map((p) => ({ ...p, id: ids.get(p.id)!, merchant_id: merchantId })), { onConflict: "merchant_id,sku", ignoreDuplicates: true });
    if (inserted.error) throw new Error(`products: ${inserted.error.message}`);
    const rows = await db.from("products").select("id, sku").eq("merchant_id", merchantId);
    const idOf = new Map((rows.data ?? []).map((r) => [r.sku as string, r.id as string]));
    const skuOf = new Map(products2.map((p) => [p.id, p.sku]));
    const stocked = await db.from("stock").upsert(stock2.map((s) => ({ ...s, product_id: idOf.get(skuOf.get(s.product_id)!)! })), { onConflict: "product_id", ignoreDuplicates: true });
    if (stocked.error) throw new Error(`stock: ${stocked.error.message}`);
    const rules = await db.from("business_rules").upsert(
      [
        { merchant_id: merchantId, key: "box_template", value: boxTemplate2 },
        { merchant_id: merchantId, key: "production_lead_days", value: { days: 7 } },
        { merchant_id: merchantId, key: "shop_profile", value: { productKind: "event welcome kit" } },
      ],
      { onConflict: "merchant_id,key", ignoreDuplicates: true },
    );
    if (rules.error) throw new Error(`rules: ${rules.error.message}`);
  }
  return { merchantId, slug: merchant2.slug, name: merchant.data.name as string };
}

export async function readyKitShop(db: SupabaseClient): Promise<Shop> {
  const { merchantId } = await ensureKitShop(db);
  // The same stock every run, so the run never depends on what an earlier one used: plenty of everything, and exactly 40 insulated bottles.
  const all = await db.from("products").select("id, sku").eq("merchant_id", merchantId);
  for (const p of all.data ?? []) {
    const onHand = p.sku === "BOTTLE-INSULATED" ? KIT_BOTTLE_STOCK : 5000;
    const reset = await db.from("stock").update({ on_hand: onHand, reserved: 0 }).eq("product_id", p.id as string);
    if (reset.error) throw new Error(`stock reset: ${reset.error.message}`);
  }

  const email = "e2e-kit-shop@test.invalid";
  const password = "e2e-kit-local-only-4c8d2e";
  let userId: string | undefined;
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.data.user) userId = created.data.user.id;
  else {
    for (let page = 1; page <= 200 && !userId; page++) {
      const listed = await db.auth.admin.listUsers({ page, perPage: 1000 });
      userId = listed.data.users.find((u) => u.email === email)?.id;
      if (listed.data.users.length < 1000) break;
    }
    if (!userId) throw new Error(`kit shop user: ${created.error?.message}`);
    await db.auth.admin.updateUserById(userId, { password, email_confirm: true });
  }
  const owned = await db.from("merchants").update({ owner_user_id: userId }).eq("id", merchantId);
  if (owned.error) throw new Error(`owner: ${owned.error.message}`);
  return { merchantId, email, password, slug: merchant2.slug, name: merchant2.name };
}
