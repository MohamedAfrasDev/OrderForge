// What /developers shows, built by the same code the API runs: the field table comes from the route's Zod schema, and the example
// responses come from the real create handler and the real pricing engine on the demo shop's seed data. Nothing here is typed by hand
// except the placeholders for ids and tokens.
import { z } from "zod";
import { boxTemplateRuleSchema, type Catalog, type Stock } from "@/domain/catalog";
import { FIELDS, handleCreateRequest, type AgentApiDeps } from "@/lib/agent-api/handlers";
import { createdSchema } from "@/lib/agent-api/schemas";
import { cents } from "@/lib/money";
import { proposeForRequest } from "@/services/agent-requests/propose";
import { agentBodySchema, parseAgentBody, type AgentBody } from "@/services/agent-requests/schema";
import { boxTemplate, businessRules, merchant, products, stock } from "../../supabase/seed/fixtures";

export const EXAMPLE_SLUG = merchant.slug;
/** Only used to give the engine a date; neither example asks for a pickup day, so the answer does not depend on it. */
const EXAMPLE_TODAY = "2026-11-06";
const EXAMPLE_ID = "11111111-2222-4333-8444-555555555555";
const HUMAN_TOKEN = "example-human-token";
const AGENT_TOKEN = "example-agent-token";

/** 20 boxes: fits the stock. */
export const FITS_BODY: AgentBody = { boxCount: 20, noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000 };
/** 30 boxes: the steel bottle has 24, so the first box cannot be made. */
export const BLOCKED_BODY: AgentBody = { boxCount: 30, noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000 };

/** The demo shop's catalog and stock, read from the seed fixtures the database is seeded from. */
function demoSnapshot(): { catalog: Catalog; stock: Stock } {
  const template = boxTemplateRuleSchema.parse(boxTemplate);
  const lead = businessRules.find((r) => r.key === "production_lead_days")?.value as { days: number } | undefined;
  return {
    catalog: {
      products: products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, category: p.category, unitPriceMinor: cents(p.unit_price_minor), isFood: p.is_food, active: true })),
      slots: template.slots,
      rules: { productionLeadDays: lead?.days ?? 0 },
    },
    stock: Object.fromEntries(stock.map((s) => [s.product_id, s.on_hand - s.reserved])),
  };
}

/** The create handler wired to the real engine and nothing else: no database, no model, fixed placeholders for ids and tokens. */
function exampleDeps(baseUrl: string): AgentApiDeps {
  const { catalog, stock: available } = demoSnapshot();
  return {
    baseUrl,
    service: {
      listStores: async () => [],
      describeStore: async () => null,
      read: async () => ({ ok: false, code: "NOT_FOUND" }),
      create: async (_slug, raw) => {
        const parsed = parseAgentBody(raw);
        if (!parsed.ok) return { ok: false, code: "INVALID_INPUT", issues: parsed.issues };
        const r = proposeForRequest({ body: parsed.value, catalog, stock: available, today: EXAMPLE_TODAY });
        return { ok: true, value: { requestId: EXAMPLE_ID, status: "CONFIGURING", humanToken: HUMAN_TOKEN, requestToken: AGENT_TOKEN, proposalStatus: r.status, proposals: r.proposals, blockers: r.blockers } };
      },
    },
  };
}

/** Post a body to the real create handler and return the parsed, schema-checked response. Throws if the handler does not answer 201. */
export async function exampleResponse(baseUrl: string, body: AgentBody): Promise<z.infer<typeof createdSchema>> {
  const request = new Request(`${baseUrl}/api/agent/v1/stores/${EXAMPLE_SLUG}/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await handleCreateRequest(exampleDeps(baseUrl), request, EXAMPLE_SLUG);
  if (response.status !== 201) throw new Error(`the example request was refused with ${response.status}`);
  return createdSchema.parse(await response.json());
}

export type ContractField = { name: string; type: string; required: boolean; range: string; description: string };

/** The five fields with their types and ranges, taken from the Zod schema the route validates against. */
export function contractFields(): ContractField[] {
  const schema = z.toJSONSchema(agentBodySchema, { io: "input", unrepresentable: "any" }) as { properties: Record<string, { type?: string; minimum?: number; maximum?: number; pattern?: string }>; required?: string[] };
  const required = new Set(schema.required ?? []);
  const words = new Map<string, string>(FIELDS.map((f) => [f.name, f.description]));
  return Object.entries(schema.properties).map(([name, p]) => ({
    name,
    type: p.type === "string" ? "string, YYYY-MM-DD" : (p.type ?? "unknown"),
    required: required.has(name),
    range: p.minimum !== undefined && p.maximum !== undefined ? `${p.minimum} to ${p.maximum}` : "",
    description: words.get(name) ?? "",
  }));
}

export function createCurl(baseUrl: string, body: AgentBody): string {
  return [`curl -X POST ${baseUrl}/api/agent/v1/stores/${EXAMPLE_SLUG}/requests`, `  -H "Content-Type: application/json"`, `  -d '${JSON.stringify(body)}'`].join(" \\\n");
}

export function readCurl(baseUrl: string): string {
  return [`curl ${baseUrl}/api/agent/v1/requests/<request id>`, `  -H "Authorization: Bearer <requestToken>"`].join(" \\\n");
}

const isFlat = (v: unknown): boolean => typeof v !== "object" || v === null || Object.values(v).every((x) => typeof x !== "object" || x === null);

/** JSON for reading: objects with only simple values sit on one line, so a box's five items take five lines. Same data, shorter. */
export function pretty(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const inner = "  ".repeat(indent + 1);
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  if (isFlat(value) && !Array.isArray(value)) return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[\n${value.map((v) => `${inner}${pretty(v, indent + 1)}`).join(",\n")}\n${pad}]`;
  return `{\n${Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${pretty(v, indent + 1)}`).join(",\n")}\n${pad}}`;
}
