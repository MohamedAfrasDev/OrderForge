import { describe, expect, it } from "vitest";
import { DEMO_STORE_SLUG } from "@/lib/demo-store";
import { merchant } from "../supabase/seed/fixtures";

describe("the demo store", () => {
  it("is the store the seed script creates", () => {
    expect(DEMO_STORE_SLUG).toBe(merchant.slug);
  });

  it("is a valid store address", () => {
    expect(DEMO_STORE_SLUG).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(DEMO_STORE_SLUG.length).toBeLessThanOrEqual(64);
  });
});
