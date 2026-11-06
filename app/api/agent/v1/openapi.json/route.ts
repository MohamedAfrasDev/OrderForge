import { handleOpenApi } from "@/lib/agent-api/handlers";

// GET /api/agent/v1/openapi.json: the OpenAPI description, generated from the same schemas the tests check responses against.
export function GET() {
  return handleOpenApi();
}
