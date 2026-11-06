import { handleListStores } from "@/lib/agent-api/handlers";
import { agentApiDeps } from "@/lib/agent-api/wiring";

// GET /api/agent/v1/stores: the demo shops an agent can ask.
export async function GET() {
  return handleListStores(agentApiDeps());
}
