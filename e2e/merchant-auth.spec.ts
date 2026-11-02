import { expect, test } from "@playwright/test";

const needsLocalSupabase = process.env.E2E_LOCAL_SUPABASE !== "1";

test.describe("merchant area gate", () => {
  test("redirects a visitor with no session to the login page", async ({ page }) => {
    await page.goto("/merchant");
    await expect(page).toHaveURL(/\/merchant\/login$/);
    await expect(page.getByRole("heading", { name: "Merchant sign in" })).toBeVisible();
  });

  test("the login page itself is reachable and shows the sandbox banner", async ({ page }) => {
    await page.goto("/merchant/login");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("status", { name: "Sandbox notice" })).toBeVisible();
  });
});

test.describe("merchant sign in (local Supabase)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  test("rejects a wrong password with a generic message", async ({ page }) => {
    await page.goto("/merchant/login");
    await page.getByLabel("Email").fill(process.env.E2E_MERCHANT_EMAIL!);
    await page.getByLabel("Password").fill("definitely-not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText("Invalid email or password.");
    await expect(page).toHaveURL(/\/merchant\/login$/);
  });

  test("keeps out a valid account that does not own a merchant", async ({ page }) => {
    await page.goto("/merchant/login");
    await page.getByLabel("Email").fill(process.env.E2E_OUTSIDER_EMAIL!);
    await page.getByLabel("Password").fill(process.env.E2E_OUTSIDER_PASSWORD!);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText("Invalid email or password.");

    await page.goto("/merchant");
    await expect(page).toHaveURL(/\/merchant\/login$/);
  });

  test("signs the merchant in, shows their portal, and signs them out", async ({ page }) => {
    await page.goto("/merchant/login");
    await page.getByLabel("Email").fill(process.env.E2E_MERCHANT_EMAIL!);
    await page.getByLabel("Password").fill(process.env.E2E_MERCHANT_PASSWORD!);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/merchant$/);
    await expect(page.getByRole("heading", { name: process.env.E2E_MERCHANT_NAME! })).toBeVisible();
    await expect(page.getByText(process.env.E2E_MERCHANT_EMAIL!)).toBeVisible();

    // Survives a reload (session cookie), then ends on sign out.
    await page.reload();
    await expect(page.getByRole("heading", { name: process.env.E2E_MERCHANT_NAME! })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/merchant\/login$/);

    await page.goto("/merchant");
    await expect(page).toHaveURL(/\/merchant\/login$/);
  });
});
