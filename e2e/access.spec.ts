import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { createCustomerLink } from "../lib/access/customer-link";

const needsLocalSupabase = process.env.E2E_LOCAL_SUPABASE !== "1";

test.describe("customer links (local Supabase)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  const env = (name: string) => process.env[name]!;

  test("a valid link opens its own inquiry and nobody else's", async ({ page }) => {
    await page.goto(`/o/${env("E2E_INQUIRY_A_LINK")}`);
    await expect(page.getByRole("heading", { name: "Your request", exact: true })).toBeVisible();
    await expect(page.getByText(env("E2E_INQUIRY_A_TEXT"))).toBeVisible();
    await expect(page.getByText(env("E2E_INQUIRY_B_TEXT"))).toHaveCount(0);

    await page.goto(`/o/${env("E2E_INQUIRY_B_LINK")}`);
    await expect(page.getByText(env("E2E_INQUIRY_B_TEXT"))).toBeVisible();
    await expect(page.getByText(env("E2E_INQUIRY_A_TEXT"))).toHaveCount(0);
  });

  test("link A cannot be turned into access to inquiry B", async ({ request }) => {
    const [, signatureOfA] = env("E2E_INQUIRY_A_LINK").split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ i: env("E2E_INQUIRY_B_ID"), v: 1, e: Date.now() + 3_600_000 }),
    ).toString("base64url");
    const response = await request.get(`/o/${forgedPayload}.${signatureOfA}`);
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain(env("E2E_INQUIRY_B_TEXT"));
  });

  test("an expired link is not found", async ({ request }) => {
    const expired = createCustomerLink({
      inquiryId: env("E2E_INQUIRY_A_ID"),
      version: 1,
      expiresAt: new Date(Date.now() - 1000),
      secret: env("E2E_ACCESS_LINK_SECRET"),
    });
    const response = await request.get(`/o/${expired}`);
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain(env("E2E_INQUIRY_A_TEXT"));
  });

  test("a link signed with some other secret is not found", async ({ request }) => {
    const foreign = createCustomerLink({
      inquiryId: env("E2E_INQUIRY_A_ID"),
      version: 1,
      expiresAt: new Date(Date.now() + 3_600_000),
      secret: "a-different-secret-that-is-long-enough",
    });
    expect((await request.get(`/o/${foreign}`)).status()).toBe(404);
  });

  test("a revoked link stops working", async ({ page }) => {
    const db = createClient(env("E2E_SUPABASE_URL"), env("E2E_SUPABASE_SERVICE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const merchant = await db.from("merchants").select("id").eq("slug", env("E2E_STORE_SLUG")).single();
    const inquiry = await db.from("inquiries").insert({ merchant_id: merchant.data!.id }).select("id").single();
    const link = createCustomerLink({
      inquiryId: inquiry.data!.id,
      version: 1,
      expiresAt: new Date(Date.now() + 3_600_000),
      secret: env("E2E_ACCESS_LINK_SECRET"),
    });

    await page.goto(`/o/${link}`);
    await expect(page.getByRole("heading", { name: "Your request", exact: true })).toBeVisible();

    await db.from("inquiries").update({ access_version: 2 }).eq("id", inquiry.data!.id);

    // Revocation needs the database, so it is decided after the page shell has streamed:
    // the status is already 200, but the content is the not-found view and nothing leaks.
    await page.goto(`/o/${link}`);
    await expect(page.getByRole("heading", { name: "We couldn't find that" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your request", exact: true })).toHaveCount(0);
  });

  test.describe("garbage links", () => {
    for (const token of ["garbage", "a.b", "a..b", "%00", "x".repeat(500)]) {
      test(`are not found: ${token.slice(0, 12)}`, async ({ request }) => {
        expect((await request.get(`/o/${encodeURIComponent(token)}`)).status()).toBe(404);
      });
    }
  });

  test("the link page is private: no caching, no referrer, no indexing", async ({ request }) => {
    const response = await request.get(`/o/${env("E2E_INQUIRY_A_LINK")}`);
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["x-robots-tag"]).toContain("noindex");
  });

  test("a storefront shows only its public name; unknown stores are not found", async ({ page }) => {
    await page.goto(`/store/${env("E2E_STORE_SLUG")}`);
    await expect(page.getByRole("heading", { name: env("E2E_MERCHANT_NAME") })).toBeVisible();

    for (const slug of ["no-such-store-zz", "Bad%20Slug!"]) {
      await page.goto(`/store/${slug}`);
      await expect(page.getByRole("heading", { name: "We couldn't find that" })).toBeVisible();
    }
  });
});

test.describe("rate limiting", () => {
  // Each limiter keys on x-forwarded-for, so these tests use their own address and never
  // exhaust the budget other tests share.
  test("slows down repeated guesses at /o/<token> per client address", async ({ request }) => {
    const attacker = { "x-forwarded-for": "198.51.100.77" };
    const statuses: number[] = [];
    for (let i = 0; i < 80; i++) {
      statuses.push((await request.get("/o/guess", { headers: attacker })).status());
    }
    expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(60).every((s) => s === 429)).toBe(true);

    const blocked = await request.get("/o/guess", { headers: attacker });
    expect(blocked.status()).toBe(429);
    expect(Number(blocked.headers()["retry-after"])).toBeGreaterThan(0);

    // A different client is unaffected.
    const other = await request.get("/o/guess", { headers: { "x-forwarded-for": "198.51.100.78" } });
    expect(other.status()).toBe(404);
  });

  test("slows down repeated requests to /store/<slug> per client address", async ({ request }) => {
    const spammer = { "x-forwarded-for": "198.51.100.88" };
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      statuses.push((await request.get("/store/nothing-here", { headers: spammer })).status());
    }
    // Unknown stores are decided after streaming (status 200); what matters is where the limit bites.
    expect(statuses.slice(0, 30).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);
  });
});
