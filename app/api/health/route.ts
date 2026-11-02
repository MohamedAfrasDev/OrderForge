import { getServerEnv } from "@/lib/env";
import { handleHealth } from "@/lib/health";
import { canReadTable } from "@/lib/health-checks";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  return handleHealth({
    checkEnv: () => {
      try {
        getServerEnv();
        return true;
      } catch {
        return false;
      }
    },
    checkDatabase: () => canReadTable(createAdminClient()),
  });
}
