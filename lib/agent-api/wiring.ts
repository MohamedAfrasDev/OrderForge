import "server-only";
import { newCorrelationId } from "@/lib/correlation";
import { getServerEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentApiDeps } from "./handlers";
import { createAgentLimits } from "./limits";
import { createAgentApiService } from "./service";

// One set of counters for the life of the server instance.
const limits = createAgentLimits();

/** The agent API wired to the running app: the admin client (every query is scoped in the services), the access secret and the public address. */
export function agentApiDeps(): AgentApiDeps {
  const env = getServerEnv();
  return {
    baseUrl: env.APP_BASE_URL,
    limits,
    service: createAgentApiService(createAdminClient(), { accessSecret: env.ACCESS_LINK_SECRET }, { now: () => new Date(), correlationId: newCorrelationId }),
  };
}
