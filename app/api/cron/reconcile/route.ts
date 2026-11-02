import { getServerEnv } from "@/lib/env";
import { handleReconcile } from "@/lib/cron/reconcile-handler";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  return handleReconcile(request, {
    cronSecret: getServerEnv().CRON_SECRET,
    insertAudit: async (row) => {
      const { error } = await createAdminClient().from("audit_events").insert(row);
      if (error) throw new Error("audit insert failed");
    },
  });
}
