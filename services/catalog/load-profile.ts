import type { SupabaseClient } from "@supabase/supabase-js";
import { parseShopProfile, type ShopProfile } from "@/domain/intake";

/**
 * The shop's `shop_profile` rule (what kind of thing it sells), scoped to one merchant. A missing or malformed rule gives the
 * default, so an unseeded or hand-edited shop keeps working exactly as before. A database error is thrown like any other read.
 */
export async function loadShopProfile(db: SupabaseClient, merchantId: string): Promise<ShopProfile> {
  const found = await db.from("business_rules").select("value").eq("merchant_id", merchantId).eq("key", "shop_profile").maybeSingle();
  if (found.error) throw new Error(`load shop profile: ${found.error.message}`);
  return parseShopProfile(found.data?.value);
}
