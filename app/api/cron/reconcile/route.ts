import { getServerEnv } from "@/lib/env";
import { handleReconcile } from "@/lib/cron/reconcile-handler";
import { createPaymentDeps } from "@/lib/payments/wiring";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcilePayments } from "@/services/payments/reconcile";
import { sweepReservations } from "@/services/reservation/sweep";

export async function POST(request: Request) {
  return handleReconcile(request, {
    cronSecret: getServerEnv().CRON_SECRET,
    insertAudit: async (row) => {
      const { error } = await createAdminClient().from("audit_events").insert(row);
      if (error) throw new Error("audit insert failed");
    },
    // Payments first (it reads PayPal and settles what it can), then the sweep, which never touches money in flight.
    reconcilePayments: (context) => reconcilePayments(createAdminClient(), createPaymentDeps(), { ...context, actor: "system:cron" }),
    sweepReservations: (context) => sweepReservations(createAdminClient(), context),
  });
}
