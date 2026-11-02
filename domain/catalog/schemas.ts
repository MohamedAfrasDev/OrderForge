import { z } from "zod";
import { cents } from "@/lib/money";
import { isCalendarDate } from "./dates";
import type { Configuration, Requirements, Slot } from "./types";

// boxCount is deliberately any number here: 0 or 2.5 is reported by the validator as INVALID_QUANTITY.
// strictObject rejects every other key, so an injected price, discount or total has nowhere to go.
export const configurationSchema: z.ZodType<Configuration> = z.strictObject({
  boxCount: z.number(),
  selections: z.record(z.string(), z.string()),
});

export const requirementsSchema: z.ZodType<Requirements, unknown> = z.strictObject({
  noFood: z.boolean(),
  maxPricePerBoxMinor: z.number().int().nonnegative().transform(cents).optional(),
  logoRequired: z.boolean(),
  requestedPickupDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isCalendarDate, "not a real calendar date")
    .optional(),
});

const slotSchema: z.ZodType<Slot> = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  quantity: z.number().int().min(1),
  allowedSkus: z
    .array(z.string().min(1))
    .min(1)
    .refine((skus) => new Set(skus).size === skus.length, "allowedSkus must not repeat a SKU"),
  customization: z.literal("logo").optional(),
});

/** The value of the merchant's `box_template` business rule. */
export const boxTemplateRuleSchema = z.strictObject({
  slots: z
    .array(slotSchema)
    .min(1)
    .refine((slots) => new Set(slots.map((s) => s.id)).size === slots.length, "slot ids must be unique"),
});

export type BoxTemplateRule = z.infer<typeof boxTemplateRuleSchema>;
