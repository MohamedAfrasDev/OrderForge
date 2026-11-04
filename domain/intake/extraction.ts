import { z } from "zod";
import { isCalendarDate } from "@/domain/catalog";
import { FIELD_STATUSES, type Extraction } from "./types";

const MAX_BOXES = 1_000_000;
const MAX_BUDGET_MINOR = 10_000_000; // $100,000 per box: far beyond anything real, small enough to catch a unit mistake
const MAX_PREFERENCES = 10;
const MAX_PREFERENCE_LENGTH = 80;

const status = z.enum(FIELD_STATUSES);

/** A reported field: a value (or null) and a status. Strict, so nothing else can ride along. */
function field<T extends z.ZodType>(value: T) {
  return z.strictObject({ value: value.nullable(), status });
}

const preference = z.string().transform((s) => s.trim()).pipe(z.string().min(1, "must not be empty").max(MAX_PREFERENCE_LENGTH, `at most ${MAX_PREFERENCE_LENGTH} characters`));

/**
 * What the model may say about the latest message. Every field is optional (left out means nothing new). strictObject rejects
 * every other key, so an injected price, discount or total has nowhere to go. Numbers must be real numbers: "20" is refused.
 */
export const extractionSchema = z.strictObject({
  boxCount: field(z.number().int("must be a whole number").min(1, "must be at least 1").max(MAX_BOXES)).optional(),
  noFood: field(z.boolean()).optional(),
  logoRequired: field(z.boolean()).optional(),
  maxPricePerBoxMinor: field(z.number().int("must be a whole number of cents").min(1, "must be at least 1 cent").max(MAX_BUDGET_MINOR)).optional(),
  requestedPickupDate: field(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must look like YYYY-MM-DD").refine(isCalendarDate, "not a real calendar date")).optional(),
  preferences: field(z.array(preference).max(MAX_PREFERENCES, `at most ${MAX_PREFERENCES} preferences`)).optional(),
});

export type ParsedExtraction = { ok: true; value: Extraction } | { ok: false; errors: string[] };

/**
 * Reads the model's raw answer into an extraction, or reports every problem at once (so one retry with these reasons can fix
 * them all). Beyond the schema, a status must agree with its value: unknown has no value; confirmed and needs_confirmation
 * must have one; conflicted may have either.
 */
export function parseExtraction(raw: unknown): ParsedExtraction {
  const parsed = extractionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "answer"}: ${i.message}`) };
  }

  const errors: string[] = [];
  for (const [name, f] of Object.entries(parsed.data)) {
    if (!f) continue;
    if (f.status === "unknown" && f.value !== null) errors.push(`${name}.value: an unknown field has no value`);
    if ((f.status === "confirmed" || f.status === "needs_confirmation") && f.value === null) errors.push(`${name}.value: a ${f.status} field needs a value`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: parsed.data as Extraction };
}
