import { z } from "zod";
import { configurationSchema, requirementsSchema } from "@/domain/catalog/schemas";

export const CONDITION_CODES = [
  "PRODUCTION_SLOT_CONFIRMATION",
  "ARTWORK_ACCEPTANCE",
  "UNSUPPORTED_CUSTOMIZATION",
  "MERCHANT_APPROVED_CUSTOMIZATION",
] as const;

export const conditionSchema = z.strictObject({
  code: z.enum(CONDITION_CODES),
  text: z.string().trim().min(1).max(500),
});

// strictObject: an amount, discount, total, status or hash has nowhere to go. Prices come from the catalog only.
export const draftInputSchema = z.strictObject({
  inquiryId: z.uuid(),
  configuration: configurationSchema,
  requirements: requirementsSchema,
  requirementVersionId: z.uuid().nullable(),
  conditions: z.array(conditionSchema),
});

export type DraftInput = z.infer<typeof draftInputSchema>;
