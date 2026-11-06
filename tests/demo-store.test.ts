import { describe, expect, it } from "vitest";
import { DEMO_STORE_SLUG, DEMO_STORE_SLUGS } from "@/lib/demo-store";
import { merchant, shops } from "../supabase/seed/fixtures";

describe("the demo store", () => {
  it("is the store the seed script creates", () => {
    expect(DEMO_STORE_SLUG).toBe(merchant.slug);
  });

  it("is a valid store address", () => {
    expect(DEMO_STORE_SLUG).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(DEMO_STORE_SLUG.length).toBeLessThanOrEqual(64);
  });
});

describe("the list of demo stores", () => {
  it("is exactly the shops the seed script creates, in the same order, so the first is the original", () => {
    expect([...DEMO_STORE_SLUGS]).toEqual(shops.map((s) => s.merchant.slug));
    expect(DEMO_STORE_SLUGS[0]).toBe(DEMO_STORE_SLUG);
  });

  it("holds only valid store addresses, each once", () => {
    for (const slug of DEMO_STORE_SLUGS) {
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(slug.length).toBeLessThanOrEqual(64);
    }
    expect(new Set(DEMO_STORE_SLUGS).size).toBe(DEMO_STORE_SLUGS.length);
  });
});
