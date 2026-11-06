import type { SupabaseClient } from "@supabase/supabase-js";
import { getPublicMerchant } from "@/lib/access/inquiry-reads";

/** The store the seed script creates first (`supabase/seed/fixtures.ts`). The home page sends first-time visitors here. */
export const DEMO_STORE_SLUG = "demo-gift-boxes";

/** Every demo store the seed script creates, in the order the home page offers them. The first is `DEMO_STORE_SLUG`. */
export const DEMO_STORE_SLUGS = [DEMO_STORE_SLUG, "demo-event-kits"] as const;

export type PublicStore = { slug: string; name: string };

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The demo store's public name and address, or null when it does not exist on this site, so the home page never offers a link
 * that leads nowhere. Public fields only.
 */
export async function findDemoStore(db: SupabaseClient, slug: string = DEMO_STORE_SLUG): Promise<PublicStore | null> {
  return getPublicMerchant(db, slug);
}

/**
 * The demo stores that exist on this site, in the order asked (missing ones are left out, so there is never a dead link).
 * Public fields only. One query.
 */
export async function findDemoStores(db: SupabaseClient, slugs: readonly string[] = DEMO_STORE_SLUGS): Promise<PublicStore[]> {
  const valid = slugs.filter((s) => SLUG.test(s) && s.length <= 64);
  if (valid.length === 0) return [];
  const { data } = await db.from("merchants").select("slug, name").in("slug", valid);
  const byslug = new Map((data ?? []).map((m) => [m.slug as string, { slug: m.slug as string, name: m.name as string }]));
  return valid.flatMap((s) => {
    const found = byslug.get(s);
    return found ? [found] : [];
  });
}
