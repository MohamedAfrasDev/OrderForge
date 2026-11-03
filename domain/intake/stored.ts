import { z } from "zod";
import { emptyRequirements } from "./requirements";
import { BLOCKING_FIELDS, FIELD_STATUSES, type BlockingField, type RequirementsDoc } from "./types";

export const STORED_REQUIREMENTS_TAG = "orderforge.requirements.v1" as const;

/** One option code found for a blocked configuration. Every figure is code's; `explanation` is the model's checked sentence. */
export type ProposalAlternative = {
  key: string;
  slotId: string;
  fromSku: string;
  toSku: string;
  perBoxMinor: number;
  totalMinor: number;
  explanation: string | null;
};

/** What the agent proposed in one turn, stored with the version so the customer sees exactly what was said. */
export type Proposal = {
  selections: Record<string, string>;
  status: "VALID" | "BLOCKED";
  /** Catalog blocker codes when BLOCKED. */
  blockers: string[];
  /** Code's price for the selections when VALID. */
  priced: { perBoxMinor: number; totalMinor: number; boxCount: number } | null;
  alternatives: ProposalAlternative[];
};

/** The one question the agent is waiting on, if any. */
export type OpenQuestion = { field: BlockingField; text: string };

/** The document stored in `requirement_versions.requirements`. A new version is written every turn; versions are never edited. */
export type StoredRequirements = {
  schema: typeof STORED_REQUIREMENTS_TAG;
  fields: RequirementsDoc;
  proposal: Proposal | null;
  question: OpenQuestion | null;
};

export function emptyStored(): StoredRequirements {
  return { schema: STORED_REQUIREMENTS_TAG, fields: emptyRequirements(), proposal: null, question: null };
}

const source = z.string().max(64).nullable();
const status = z.enum(FIELD_STATUSES);
const field = <T extends z.ZodType>(value: T) => z.strictObject({ value: value.nullable(), status, source });

const alternativeSchema = z.strictObject({
  key: z.string().min(1).max(40),
  slotId: z.string().min(1).max(80),
  fromSku: z.string().min(1).max(80),
  toSku: z.string().min(1).max(80),
  perBoxMinor: z.number().int(),
  totalMinor: z.number().int(),
  explanation: z.string().max(600).nullable(),
});

const proposalSchema = z.strictObject({
  selections: z.record(z.string().max(80), z.string().max(80)),
  status: z.enum(["VALID", "BLOCKED"]),
  blockers: z.array(z.string().max(60)).max(50),
  priced: z.strictObject({ perBoxMinor: z.number().int(), totalMinor: z.number().int(), boxCount: z.number().int() }).nullable(),
  alternatives: z.array(alternativeSchema).max(20),
});

/** Reads a stored document back, strictly: an unknown key, tag or status is refused rather than guessed at. */
export const storedRequirementsSchema: z.ZodType<StoredRequirements> = z.strictObject({
  schema: z.literal(STORED_REQUIREMENTS_TAG),
  fields: z.strictObject({
    boxCount: field(z.number()),
    noFood: field(z.boolean()),
    logoRequired: field(z.boolean()),
    maxPricePerBoxMinor: field(z.number()),
    requestedPickupDate: field(z.string()),
    preferences: field(z.array(z.string())),
  }),
  proposal: proposalSchema.nullable(),
  question: z.strictObject({ field: z.enum(BLOCKING_FIELDS), text: z.string().max(300) }).nullable(),
});
