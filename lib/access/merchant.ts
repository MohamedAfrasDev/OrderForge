// Merchant authorization. The decision itself is pure so it can be unit tested;
// requireMerchant() in lib/access/require-merchant.ts feeds it real data on the server.

export type SessionUser = { id: string; email?: string | null };
export type OwnedMerchant = { id: string; name: string; slug: string };

export type MerchantAccess =
  | { ok: true; user: SessionUser; merchant: OwnedMerchant }
  | { ok: false; reason: "unauthenticated" | "no_merchant" };

/**
 * `merchants` must be what the signed-in user can see under row level security
 * (their own rows only). A user with no merchant is signed in but not a merchant.
 */
export function decideMerchantAccess(
  user: SessionUser | null | undefined,
  merchants: readonly OwnedMerchant[],
): MerchantAccess {
  if (!user) return { ok: false, reason: "unauthenticated" };
  const merchant = merchants[0];
  if (!merchant) return { ok: false, reason: "no_merchant" };
  return { ok: true, user, merchant };
}
