import { z } from "zod";
import { isCalendarDate } from "@/domain/catalog";

/** An API sanity cap, far below the intake's own limit. */
export const MAX_AGENT_BOXES = 10_000;
/** The same ceiling the intake uses for a per-box budget ($100,000), small enough to catch a unit mistake. */
const MAX_BUDGET_MINOR = 10_000_000;

/**
 * The only thing an agent may send: the five intake fields. strictObject rejects every other key, so a price, a total, a discount,
 * a status, a product choice or any free text has nowhere to go. Numbers must be real numbers ("20" is refused).
 */
export const agentBodySchema = z.strictObject({
  boxCount: z.number().int().min(1).max(MAX_AGENT_BOXES),
  noFood: z.boolean(),
  logoRequired: z.boolean(),
  maxPricePerBoxMinor: z.number().int().min(1).max(MAX_BUDGET_MINOR),
  requestedPickupDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isCalendarDate)
    .optional(),
});

export type AgentBody = z.infer<typeof agentBodySchema>;

export type AgentIssueCode = "unknown_key" | "required" | "invalid_type" | "out_of_range" | "invalid_date" | "invalid_body";
/** A problem with the body. Only a field name and a code: what was sent is never echoed back. */
export type AgentIssue = { field: string; code: AgentIssueCode };

export type ParsedAgentBody = { ok: true; value: AgentBody } | { ok: false; issues: AgentIssue[] };

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const KNOWN = new Set(Object.keys(agentBodySchema.shape));

export function parseAgentBody(raw: unknown): ParsedAgentBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, issues: [{ field: "(body)", code: "invalid_body" }] };
  const parsed = agentBodySchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };

  const issues: AgentIssue[] = [];
  const seen = new Set<string>();
  const add = (field: string, code: AgentIssueCode) => {
    const key = `${field}:${code}`;
    if (!seen.has(key)) {
      seen.add(key);
      issues.push({ field, code });
    }
  };
  for (const issue of parsed.error.issues) {
    if (issue.code === "unrecognized_keys") {
      // The names of unknown keys are the sender's own text: only plain short names are repeated back.
      for (const key of issue.keys) add(SAFE_NAME.test(key) && !KNOWN.has(key) ? key : "(other)", "unknown_key");
      continue;
    }
    const field = typeof issue.path[0] === "string" && KNOWN.has(issue.path[0]) ? issue.path[0] : "(body)";
    if (issue.code === "invalid_type") add(field, issue.message.toLowerCase().includes("received undefined") ? "required" : "invalid_type");
    else if (issue.code === "too_small" || issue.code === "too_big") add(field, "out_of_range");
    else if (field === "requestedPickupDate") add(field, "invalid_date");
    else add(field, "out_of_range");
  }
  return { ok: false, issues };
}
