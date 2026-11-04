// The way in for a first-time visitor, and the calm page for anything that leads nowhere, in a real browser against the LOCAL stack.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { createCustomerLink } from "../lib/access/customer-link";
import { DEMO_STORE_SLUG } from "../lib/demo-store";
import { adminClient, needsLocalSupabase } from "./payments-support";

const CALM = "We couldn't find that";

test.beforeEach(async ({ page }) => {
  // A private address per test: these pages are rate limited per address and other specs share the default one.
  const a = Math.floor(Math.random() * 250) + 1;
  const b = Math.floor(Math.random() * 250) + 1;
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `100.64.${a}.${b}` });
});

test.describe("the home page (local Supabase)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  let storeName: string;

  test.beforeAll(async () => {
    db = adminClient();
    // The demo store is the one the seed script makes. If this stack has no seed, make it (and leave it: it is harmless).
    // Workers start at the same time, so the creation tolerates a store that appeared a moment earlier.
    const made = await db.from("merchants").upsert({ slug: DEMO_STORE_SLUG, name: "Demo Gift Boxes (simulated)" }, { onConflict: "slug", ignoreDuplicates: true });
    if (made.error) throw new Error(made.error.message);
    const found = await db.from("merchants").select("name").eq("slug", DEMO_STORE_SLUG).single();
    if (found.error) throw new Error(found.error.message);
    storeName = found.data.name as string;
  });

  test("says what it is in one sentence, offers the customer flow first and shop sign in second", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "OrderForge" })).toBeVisible();
    await expect(page.getByText("Order custom gift boxes by describing what you need")).toBeVisible();

    const customer = page.getByRole("link", { name: "Try it as a customer" });
    const shop = page.getByRole("link", { name: "Shop sign in" });
    await expect(customer).toHaveAttribute("href", `/store/${DEMO_STORE_SLUG}`);
    await expect(shop).toHaveAttribute("href", "/merchant");
    const [first, second] = await Promise.all([customer.boundingBox(), shop.boundingBox()]);
    expect(first!.x).toBeLessThan(second!.x); // the customer's way in comes first

    await customer.click();
    await expect(page).toHaveURL(new RegExp(`/store/${DEMO_STORE_SLUG}$`));
    await expect(page.getByRole("heading", { name: storeName })).toBeVisible();
  });

  test("at phone width the page does not scroll sideways, the main button is on screen, and the sandbox banner stays slim", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/");
    const customer = page.getByRole("link", { name: "Try it as a customer" });
    await expect(customer).toBeVisible();
    const box = await customer.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    const banner = await page.getByRole("status", { name: "Sandbox notice" }).boundingBox();
    expect(banner!.height).toBeLessThanOrEqual(30);
  });

  const secret = () => process.env.E2E_ACCESS_LINK_SECRET!;
  const link = (inquiryId: string, version = 1) => createCustomerLink({ inquiryId, version, expiresAt: new Date(Date.now() + 3_600_000), secret: secret() });

  test("a wrong link gets the calm page, a real 404, and a way home", async ({ page, request }) => {
    const good = link(randomUUID());
    const at = good.length - 8; // inside the signature, where a changed character really changes the bytes
    const forged = good.slice(0, at) + (good[at] === "A" ? "B" : "A") + good.slice(at + 1);

    expect((await request.get(`/o/${forged}`, { headers: { "x-forwarded-for": "100.64.250.1" } })).status()).toBe(404);
    await page.goto(`/o/${forged}`);
    await expect(page.getByRole("heading", { name: CALM })).toBeVisible();
    await page.getByRole("link", { name: "Go to the home page" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1, name: "OrderForge" })).toBeVisible();

    await page.goto("/o/garbage");
    await expect(page.getByRole("heading", { name: CALM })).toBeVisible();
    await page.goto("/store/no-such-store-zz");
    await expect(page.getByRole("heading", { name: CALM })).toBeVisible();
    await page.goto("/this/does/not/exist");
    await expect(page.getByRole("heading", { name: CALM })).toBeVisible();
  });

  test("a revoked link and a link to nothing look exactly the same, so the page says nothing about whether a request exists", async ({ page }) => {
    const merchant = await db.from("merchants").select("id").eq("slug", DEMO_STORE_SLUG).single();
    const inquiry = await db.from("inquiries").insert({ merchant_id: merchant.data!.id }).select("id").single();
    if (inquiry.error) throw new Error(inquiry.error.message);
    const id = inquiry.data.id as string;

    await page.goto(`/o/${link(id)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Your request", exact: true })).toBeVisible(); // it works while valid

    const revoked = await db.from("inquiries").update({ access_version: 2 }).eq("id", id);
    if (revoked.error) throw new Error(revoked.error.message);
    await page.goto(`/o/${link(id)}`);
    await expect(page.getByRole("heading", { name: CALM })).toBeVisible();
    const revokedText = await page.getByRole("main").innerText();

    await page.goto(`/o/${link(randomUUID())}`);
    await expect(page.getByRole("heading", { name: CALM })).toBeVisible();
    expect(await page.getByRole("main").innerText()).toBe(revokedText);
  });
});
