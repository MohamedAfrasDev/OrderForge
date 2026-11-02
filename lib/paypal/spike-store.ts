// Writes spike evidence to the database. Relative imports and erasable syntax so scripts/ can use it.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditRow } from "../audit.ts";
import type { SpikeEventRow } from "./spike.ts";

/** payment_events (source "spike") and audit_events writers for a service-role client. */
export function spikeStore(db: SupabaseClient) {
  return {
    async recordEvent(row: SpikeEventRow): Promise<void> {
      const { error } = await db.from("payment_events").insert(row);
      if (error) throw new Error(`payment_events insert failed: ${error.code ?? "unknown"}`);
    },
    async insertAudit(row: AuditRow): Promise<void> {
      const { error } = await db.from("audit_events").insert(row);
      if (error) throw new Error(`audit_events insert failed: ${error.code ?? "unknown"}`);
    },
  };
}
