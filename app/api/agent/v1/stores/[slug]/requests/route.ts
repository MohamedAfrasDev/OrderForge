import { handleCreateRequest } from "@/lib/agent-api/handlers";
import { agentApiDeps } from "@/lib/agent-api/wiring";

// POST /api/agent/v1/stores/{slug}/requests: five fields in, a priced box and a link for a person out. Cannot pay, accept or publish a price.
export async function POST(request: Request, ctx: RouteContext<"/api/agent/v1/stores/[slug]/requests">) {
  const { slug } = await ctx.params;
  return handleCreateRequest(agentApiDeps(), request, slug);
}
