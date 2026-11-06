import { MAX_AGENT_BOXES } from "@/services/agent-requests/schema";
import type { AgentCreated, AgentResult } from "@/services/agent-requests/create";
import type { AgentRequestView } from "@/services/agent-requests/read";
import type { AgentLimits, LimitKind } from "./limits";
import { openApiDocument } from "./schemas";

// The HTTP layer of the agent API: parse, call the service, map coded results to JSON and a status. No business rule lives here. Pure of
// Next.js (a Request in, a Response out) so it is tested without a server; the route files only wire it to the app.

/** The largest request body read, in bytes. The five fields fit in well under a tenth of this. */
export const MAX_BODY_BYTES = 2048;

export type StoreLite = { slug: string; name: string; kind: string };
export type StoreInfo = StoreLite & { parts: Array<{ id: string; label: string }> };

export type AgentApiService = {
  listStores(): Promise<StoreLite[]>;
  describeStore(slug: string): Promise<StoreInfo | null>;
  create(slug: string, body: unknown): Promise<AgentResult<AgentCreated>>;
  read(requestId: string, token: string | undefined): Promise<AgentResult<AgentRequestView>>;
};

export type AgentApiDeps = { service: AgentApiService; baseUrl: string; limits?: AgentLimits };

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...extra } });
}

const error = (status: number, code: string, issues?: Array<{ field: string; code: string }>, extra: Record<string, string> = {}) => json(status, { error: { code, ...(issues ? { issues } : {}) } }, extra);
const tooMany = (retryAfterSeconds: number) => error(429, "RATE_LIMITED", undefined, { "Retry-After": String(retryAfterSeconds) });

/** The limit check every handler starts with, before any body is read or token checked. A refusal is the whole response. */
function limited(deps: AgentApiDeps, kind: LimitKind, request: Request, slug?: string): Response | null {
  const verdict = deps.limits?.check(kind, request, slug);
  return verdict && !verdict.allowed ? tooMany(verdict.retryAfterSeconds) : null;
}
export const notFound = () => error(404, "NOT_FOUND");

const BEARER = /^Bearer ([A-Za-z0-9._~-]{1,600})$/;

/** The token from the Authorization header only: never from the address, where it would be logged and cached. */
export function bearerToken(request: Request): string | undefined {
  return BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
}

/** The field descriptions the store description serves. Exported so the /developers page shows the same words. */
export const FIELDS = [
  { name: "boxCount", type: "integer", required: true, min: 1, max: MAX_AGENT_BOXES, description: "How many boxes." },
  { name: "noFood", type: "boolean", required: true, description: "True if the order must contain no food." },
  { name: "logoRequired", type: "boolean", required: true, description: "True if the customer's logo must be on the order." },
  { name: "maxPricePerBoxMinor", type: "integer", required: true, min: 1, max: 10_000_000, description: "The most the customer will pay per box, in cents (USD)." },
  { name: "requestedPickupDate", type: "string (YYYY-MM-DD)", required: false, description: "The earliest pickup day wanted." },
];

export async function handleListStores(deps: AgentApiDeps, request?: Request): Promise<Response> {
  const slow = request ? limited(deps, "list", request) : null;
  if (slow) return slow;
  const stores = await deps.service.listStores();
  return json(200, {
    stores: stores.map((s) => ({
      ...s,
      simulated: true as const,
      links: { describe: `/api/agent/v1/stores/${s.slug}`, createRequest: `/api/agent/v1/stores/${s.slug}/requests` },
    })),
  });
}

export async function handleDescribeStore(deps: AgentApiDeps, slug: string, request?: Request): Promise<Response> {
  const slow = request ? limited(deps, "describe", request) : null;
  if (slow) return slow;
  const store = await deps.service.describeStore(slug);
  if (!store) return notFound();
  return json(200, {
    slug: store.slug,
    name: store.name,
    kind: store.kind,
    simulated: true as const,
    currency: "USD" as const,
    fulfilment: "customer_pickup" as const,
    parts: store.parts,
    request: { method: "POST" as const, path: `/api/agent/v1/stores/${store.slug}/requests`, fields: FIELDS, unknownFieldsRejected: true as const, freeText: false as const },
    payment: {
      approvedBy: "human" as const,
      note: "An agent cannot choose a price, accept it or pay. A person opens humanUrl, chooses the box, accepts the exact price and approves the payment on PayPal's own page.",
    },
  });
}

export async function handleCreateRequest(deps: AgentApiDeps, request: Request, slug: string): Promise<Response> {
  const slow = limited(deps, "create", request, slug);
  if (slow) return slow;
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return error(415, "UNSUPPORTED_MEDIA_TYPE");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return error(413, "PAYLOAD_TOO_LARGE");

  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return error(413, "PAYLOAD_TOO_LARGE");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return error(400, "INVALID_JSON");
  }

  const out = await deps.service.create(slug, body);
  if (!out.ok) {
    if (out.code === "INVALID_INPUT") return error(400, "INVALID_INPUT", out.issues);
    if (out.code === "RATE_LIMITED") return tooMany(out.retryAfterSeconds);
    return notFound();
  }

  const v = out.value;
  return json(201, {
    request: { id: v.requestId, status: v.status, proposalStatus: v.proposalStatus, proposals: v.proposals, blockers: v.blockers },
    humanUrl: `${deps.baseUrl.replace(/\/+$/, "")}/o/${v.humanToken}`,
    requestToken: v.requestToken,
    note: "Send requestToken as 'Authorization: Bearer <token>' to GET /api/agent/v1/requests/{id}. Give humanUrl to a person: only they can choose the box, accept the price and pay.",
  });
}

export async function handleReadRequest(deps: AgentApiDeps, request: Request, requestId: string): Promise<Response> {
  const slow = limited(deps, "read", request);
  if (slow) return slow;
  const out = await deps.service.read(requestId, bearerToken(request));
  if (!out.ok) return notFound();
  const v = out.value;
  return json(200, { request: { id: v.requestId, status: v.status, proposalStatus: v.proposalStatus, proposals: v.proposals, blockers: v.blockers, missing: v.missing } });
}

export function handleOpenApi(): Response {
  return Response.json(openApiDocument(), { headers: { "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=300" } });
}
