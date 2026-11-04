import { z } from "zod";

/** A new product's SKU: starts with a letter or digit, then letters, digits, dot, dash or underscore; 1 to 64 characters. */
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const LIMITS = { nameMax: 120, categoryMax: 64, priceMaxMinor: 10_000_000, onHandMax: 1_000_000, slotsMax: 20 } as const;

const name = z.string().trim().min(1).max(LIMITS.nameMax);
const category = z.string().trim().min(1).max(LIMITS.categoryMax);
/** Whole cents. A fractional or negative amount, or a string, has no way in. */
const priceMinor = z.number().int().min(0).max(LIMITS.priceMaxMinor);
const onHand = z.number().int().min(0).max(LIMITS.onHandMax);

// strictObject everywhere: a key that is not listed (a merchant id, a reserved count, a SKU on an edit) is refused, never ignored.
export const addProductSchema = z.strictObject({
  sku: z.string().regex(SKU_PATTERN),
  name,
  category,
  priceMinor,
  isFood: z.boolean(),
  onHand,
  /** The parts of the box the new product may go in. At least one: a product in no slot could never be sold. */
  slotIds: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(LIMITS.slotsMax)
    .refine((ids) => new Set(ids).size === ids.length, "slot ids must not repeat"),
});
export type AddProductInput = z.infer<typeof addProductSchema>;

/** What an edit may change. The SKU is not here: it is fixed once the product exists. */
export const editProductSchema = z
  .strictObject({
    name: name.optional(),
    category: category.optional(),
    priceMinor: priceMinor.optional(),
    isFood: z.boolean().optional(),
    active: z.boolean().optional(),
    onHand: onHand.optional(),
  })
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), "nothing to change");
export type EditProductInput = z.infer<typeof editProductSchema>;
export type EditableField = keyof EditProductInput;
