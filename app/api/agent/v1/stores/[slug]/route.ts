import { handleDescribeStore } from "@/lib/agent-api/handlers";
import { agentApiDeps } from "@/lib/agent-api/wiring";

// GET /api/agent/v1/stores/{slug}: what the shop needs in a request, and that a person approves the payment.
export async function GET(_request: Request, ctx: RouteContext<"/api/agent/v1/stores/[slug]">) {
  const { slug } = await ctx.params;
  return handleDescribeStore(agentApiDeps(), slug);
}
