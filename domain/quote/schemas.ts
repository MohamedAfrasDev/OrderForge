import { z } from "zod";
import { configurationSchema, requirementsSchema } from "@/domain/catalog/schemas";
import { cents } from "@/lib/money";

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

const money = z.number().int().nonnegative().transform(cents);

/** The shape stored in `quote_versions.lines`. Read back with this before hashing; a row that does not fit is not trusted. */
export const storedLinesSchema = z.strictObject({
  boxCount: z.number().int().min(1),
  perBoxMinor: money,
  lines: z
    .array(
      z.strictObject({
        slotId: z.string().min(1),
        sku: z.string().min(1),
        name: z.string().min(1),
        unitPriceMinor: money,
        quantity: z.number().int().min(1),
      }),
    )
    .min(1),
});

export const storedConditionsSchema = z.array(conditionSchema);
