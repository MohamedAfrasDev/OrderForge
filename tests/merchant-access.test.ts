import { describe, expect, it } from "vitest";
import { decideMerchantAccess } from "@/lib/access/merchant";

const user = { id: "user-1", email: "m@example.test" };
const merchant = { id: "merchant-1", name: "Demo", slug: "demo" };

describe("decideMerchantAccess", () => {
  it("denies when there is no signed-in user", () => {
    expect(decideMerchantAccess(null, [merchant])).toEqual({ ok: false, reason: "unauthenticated" });
    expect(decideMerchantAccess(undefined, [merchant])).toEqual({ ok: false, reason: "unauthenticated" });
  });

  it("denies a signed-in user who owns no merchant", () => {
    expect(decideMerchantAccess(user, [])).toEqual({ ok: false, reason: "no_merchant" });
  });

  it("allows a user who owns a merchant, returning that merchant", () => {
    expect(decideMerchantAccess(user, [merchant])).toEqual({ ok: true, user, merchant });
  });

  it("uses the first merchant when several are visible (v1 has one per user)", () => {
    const other = { id: "merchant-2", name: "Other", slug: "other" };
    const result = decideMerchantAccess(user, [merchant, other]);
    expect(result.ok && result.merchant.id).toBe("merchant-1");
  });

  it("never lets an unauthenticated caller through even if merchants are supplied", () => {
    const result = decideMerchantAccess(null, [merchant]);
    expect(result.ok).toBe(false);
  });
});
