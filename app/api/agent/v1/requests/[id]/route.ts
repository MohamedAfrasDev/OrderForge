import { handleReadRequest } from "@/lib/agent-api/handlers";
import { agentApiDeps } from "@/lib/agent-api/wiring";

// GET /api/agent/v1/requests/{id}: read the request you made, with its token in the Authorization header. Read-only.
export async function GET(request: Request, ctx: RouteContext<"/api/agent/v1/requests/[id]">) {
  const { id } = await ctx.params;
  return handleReadRequest(agentApiDeps(), request, id);
}
