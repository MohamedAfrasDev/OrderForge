import type { SupabaseClient } from "@supabase/supabase-js";
import { getPublicMerchant } from "@/lib/access/inquiry-reads";

/** The store the seed script creates (`supabase/seed/fixtures.ts`). The home page sends first-time visitors here. */
export const DEMO_STORE_SLUG = "demo-gift-boxes";

/**
 * The demo store's public name and address, or null when it does not exist on this site, so the home page never offers a link
 * that leads nowhere. Public fields only.
 */
export async function findDemoStore(db: SupabaseClient, slug: string = DEMO_STORE_SLUG): Promise<{ slug: string; name: string } | null> {
  return getPublicMerchant(db, slug);
}
