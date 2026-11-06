// The public "how it stays safe" page in a real browser. It needs no login and no database.
import { expect, test } from "@playwright/test";
import { claimsIn } from "../lib/claims";
import { forbiddenIn } from "../domain/journey";

test.beforeEach(async ({ page }) => {
  // A private address per test: pages are rate limited per address and other specs share the default one.
  const a = Math.floor(Math.random() * 250) + 1;
  const b = Math.floor(Math.random() * 250) + 1;
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `100.65.${a}.${b}` });
});

test("opens without signing in and explains the problem, the three failures and the two rules", async ({ page }) => {
  const res = await page.goto("/how-it-works");
  expect(res!.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "How it stays safe" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "The problem" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Three things that go wrong" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(5);
  await expect(page.getByText("This is a sandbox demo with synthetic data. Nothing real is charged.")).toBeVisible();
});

test("the words on screen make no unmeasured claim and use no system vocabulary", async ({ page }) => {
  await page.goto("/how-it-works");
  const text = await page.locator("main").innerText();
  expect(claimsIn(text)).toEqual([]);
  expect(forbiddenIn(text)).toEqual([]);
});

test("links go to the proof file, the code and the demo", async ({ page }) => {
  await page.goto("/how-it-works");
  await expect(page.getByRole("link", { name: "See the proof file" })).toHaveAttribute("href", /doc\/evidence\/proof-points\.md$/);
  await expect(page.getByRole("link", { name: "See the code" })).toHaveAttribute("href", /github\.com\/.+\/OrderForge$/);
  await page.getByRole("link", { name: "Try the demo" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("the home page links to it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "How it stays safe" }).click();
  await expect(page).toHaveURL(/\/how-it-works$/);
});

test("at phone width the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/how-it-works");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
