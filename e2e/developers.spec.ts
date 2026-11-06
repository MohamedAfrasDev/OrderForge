// The public developers page in a real browser. It needs no login and no database.
import { expect, test } from "@playwright/test";
import { claimsIn } from "../lib/claims";

test.beforeEach(async ({ page }) => {
  // A private address per test: pages are rate limited per address and other specs share the default one.
  const a = Math.floor(Math.random() * 250) + 1;
  const b = Math.floor(Math.random() * 250) + 1;
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `100.66.${a}.${b}` });
});

test("opens without signing in and states what the agent cannot do", async ({ page }) => {
  const res = await page.goto("/developers");
  expect(res!.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "For agent developers" })).toBeVisible();
  await expect(page.getByText("The agent can request and read; it cannot accept or pay.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "What the agent cannot do" })).toBeVisible();
  await expect(page.getByText("This is a sandbox demo with synthetic data. Nothing real is charged.")).toBeVisible();
});

test("shows the five fields, a copyable curl and the code-priced figures", async ({ page }) => {
  await page.goto("/developers");
  for (const name of ["boxCount", "noFood", "logoRequired", "maxPricePerBoxMinor", "requestedPickupDate"]) {
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
  }
  const curl = page.getByLabel("curl for a request of twenty boxes", { exact: true });
  await expect(curl).toContainText("curl -X POST");
  await expect(curl).toContainText('"boxCount":20');
  await expect(page.getByText("$35.00", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("$700.00", { exact: false }).first()).toBeVisible();
  await expect(page.getByLabel("response for a request of thirty boxes", { exact: true })).toContainText("INSUFFICIENT_STOCK");
});

test("the copy button puts the curl on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/developers");
  await page.getByRole("button", { name: "Copy: curl for a request of twenty boxes" }).click();
  await expect(page.getByRole("button", { name: "Copy: curl for a request of twenty boxes" })).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("curl -X POST");
});

test("links to the OpenAPI file, and it opens", async ({ page, request }) => {
  await page.goto("/developers");
  const link = page.getByRole("link", { name: "OpenAPI description (JSON)" });
  await expect(link).toHaveAttribute("href", "/api/agent/v1/openapi.json");
  expect((await request.get("/api/agent/v1/openapi.json")).status()).toBe(200);
});

test("the home page links to it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "For agent developers" }).click();
  await expect(page).toHaveURL(/\/developers$/);
});

test("the prose makes no unmeasured claim and names no MCP or autonomous payment", async ({ page }) => {
  await page.goto("/developers");
  const text = await page.locator("main").innerText();
  expect(claimsIn(text)).toEqual([]);
  expect(text).not.toMatch(/\bMCP\b|autonomous/i);
});

test("at phone width the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/developers");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
