import { z } from "zod";

/** What the intake assistant is told the shop sells when a shop has no profile rule: the original demo shop's kind. */
export const DEFAULT_PRODUCT_KIND = "gift box";

/**
 * What the model is told about the shop. Only a short plain kind of product: letters, digits, spaces and hyphens, so a value
 * that reaches a prompt can never carry punctuation, a newline, a fence line or an instruction.
 */
export const shopProfileSchema = z.strictObject({
  productKind: z
    .string()
    .transform((s) => s.trim().replace(/ {2,}/g, " "))
    .pipe(z.string().regex(/^[A-Za-z][A-Za-z0-9 -]{0,39}$/)),
});

export type ShopProfile = z.infer<typeof shopProfileSchema>;

/** The `shop_profile` business rule, or the default for anything missing or malformed, so a bad rule never breaks intake. */
export function parseShopProfile(value: unknown): ShopProfile {
  const parsed = shopProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : { productKind: DEFAULT_PRODUCT_KIND };
}
