import { getServerEnv } from "@/lib/env";
import { handleHealth } from "@/lib/health";
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
    checkDatabase: async () => {
      const { error } = await createAdminClient().from("merchants").select("id", { head: true }).limit(1);
      return !error;
    },
  });
}
