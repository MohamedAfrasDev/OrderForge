import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * True when one row can be read from a table the app depends on.
 *
 * This is a real GET on purpose. A HEAD request (supabase-js `head: true`) reports no error for a
 * table that does not exist, which made the health check say "ok" against an empty database.
 */
export async function canReadTable(db: SupabaseClient, table = "merchants"): Promise<boolean> {
  const { error } = await db.from(table).select("id").limit(1);
  return !error;
}
