import { z } from "zod";
import { agentBodySchema } from "@/services/agent-requests/schema";

// The shape of every response of the agent API, written once. The handlers' tests check real responses against these schemas, and the
// OpenAPI document served at /api/agent/v1/openapi.json is generated from them, so the description cannot drift from the behaviour.

const cents = z.number().int();

export const lineSchema = z.strictObject({ slotId: z.string(), sku: z.string(), name: z.string(), unitPriceMinor: cents, quantity: z.number().int() });

export const proposalSchema = z.strictObject({
  kind: z.enum(["BOX", "SWAP"]),
  lines: z.array(lineSchema),
  perBoxMinor: cents,
  totalMinor: cents,
  boxCount: z.number().int(),
  currency: z.literal("USD"),
  swap: z.strictObject({ slotId: z.string(), fromSku: z.string(), toSku: z.string() }).optional(),
});

/** A coded reason the first box could not be made. The fields depend on the code; amounts are integer cents. */
export const blockerSchema = z.looseObject({ code: z.string() });

export const storeSummarySchema = z.strictObject({
  slug: z.string(),
  name: z.string(),
  kind: z.string(),
  simulated: z.literal(true),
  links: z.strictObject({ describe: z.string(), createRequest: z.string() }),
});

export const storeListSchema = z.strictObject({ stores: z.array(storeSummarySchema) });

export const storeDescriptionSchema = z.strictObject({
  slug: z.string(),
  name: z.string(),
  kind: z.string(),
  simulated: z.literal(true),
  currency: z.literal("USD"),
  fulfilment: z.literal("customer_pickup"),
  parts: z.array(z.strictObject({ id: z.string(), label: z.string() })),
  request: z.strictObject({ method: z.literal("POST"), path: z.string(), fields: z.array(z.strictObject({ name: z.string(), type: z.string(), required: z.boolean(), min: z.number().optional(), max: z.number().optional(), description: z.string() })), unknownFieldsRejected: z.literal(true), freeText: z.literal(false) }),
  payment: z.strictObject({ approvedBy: z.literal("human"), note: z.string() }),
});

export const createdSchema = z.strictObject({
  request: z.strictObject({
    id: z.string(),
    status: z.string(),
    proposalStatus: z.enum(["VALID", "BLOCKED"]),
    proposals: z.array(proposalSchema),
    blockers: z.array(blockerSchema),
  }),
  humanUrl: z.string(),
  requestToken: z.string(),
  note: z.string(),
});

export const requestViewSchema = z.strictObject({
  request: z.strictObject({
    id: z.string(),
    status: z.string(),
    proposalStatus: z.enum(["VALID", "BLOCKED"]).nullable(),
    proposals: z.array(proposalSchema),
    blockers: z.array(blockerSchema),
    missing: z.array(z.string()),
  }),
});

export const errorSchema = z.strictObject({
  error: z.strictObject({ code: z.enum(["NOT_FOUND", "INVALID_INPUT", "INVALID_JSON", "PAYLOAD_TOO_LARGE", "RATE_LIMITED", "UNSUPPORTED_MEDIA_TYPE"]), issues: z.array(z.strictObject({ field: z.string(), code: z.string() })).optional() }),
});

const json = (schema: z.ZodType) => ({ "application/json": { schema: z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) } });
const response = (description: string, schema: z.ZodType) => ({ description, content: json(schema) });
const slugParam = { name: "slug", in: "path", required: true, schema: { type: "string" } };

/** The OpenAPI 3.1 description of the agent API, built from the schemas above. Relative paths: it is served from the same host it describes. */
export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "OrderForge agent API",
      version: "1.0.0",
      description:
        "Sandbox demo with synthetic data. An agent can ask a demo shop for a priced box and read the result. It cannot choose a price, accept a quote, " +
        "pay, or read any other request. A human opens the returned humanUrl to choose the box, accept the exact price and approve the payment on PayPal.",
    },
    paths: {
      "/api/agent/v1/stores": { get: { summary: "List the demo shops", responses: { "200": response("The shops", storeListSchema) } } },
      "/api/agent/v1/stores/{slug}": {
        get: { summary: "What a shop needs to make a request", parameters: [slugParam], responses: { "200": response("The shop and its request fields", storeDescriptionSchema), "404": response("No such shop", errorSchema) } },
      },
      "/api/agent/v1/stores/{slug}/requests": {
        post: {
          summary: "Ask a shop for a priced box",
          parameters: [slugParam],
          requestBody: { required: true, content: json(agentBodySchema) },
          responses: {
            "201": response("The request, the box code chose and priced, a link for a human, and a read-only token", createdSchema),
            "400": response("Invalid body or invalid JSON; nothing was stored", errorSchema),
            "404": response("No such shop", errorSchema),
            "413": response("Body too large", errorSchema),
            "415": response("Content-Type must be application/json", errorSchema),
            "429": response("Too many requests; see Retry-After", errorSchema),
          },
        },
      },
      "/api/agent/v1/requests/{id}": {
        get: {
          summary: "Read the request you made",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          security: [{ requestToken: [] }],
          responses: { "200": response("Status and proposals, computed now by code", requestViewSchema), "404": response("Wrong token, wrong id, expired or revoked: always the same answer", errorSchema) },
        },
      },
    },
    components: { securitySchemes: { requestToken: { type: "http", scheme: "bearer", description: "The requestToken returned when the request was made. Read-only." } } },
  };
}
