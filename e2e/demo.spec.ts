// The public /demo page in a real browser, against the local database and the stand-in model (mocked: no real model, no real PayPal).
// The button must reach the real order room with the prepared message sent.
import { expect, test } from "@playwright/test";
import { forbiddenIn } from "../domain/journey";
import { demoScript } from "../domain/demo/scripts";
import { claimsIn } from "../lib/claims";
import { readyDemoShop } from "./journey-support";
import { adminClient, needsLocalSupabase } from "./payments-support";
import { ensureKitShop } from "./second-shop-support";

test.beforeEach(async ({ page }) => {
  // A private address per test: the pages are rate limited per address and other specs share the default one.
  const a = Math.floor(Math.random() * 250) + 1;
  const b = Math.floor(Math.random() * 250) + 1;
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `100.67.${a}.${b}` });
});

test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

// Both demo shops are made ready on the local stack (and left in place: they are harmless). CI starts from an empty database, so neither can be
// assumed. A shop that is not on a site gets no button, which the demo-store tests cover; here both exist so both buttons can be pressed.
test.beforeAll(async () => {
  const db = adminClient();
  await readyDemoShop(db);
  await ensureKitShop(db);
});

const gift = demoScript("demo-gift-boxes", "welcome-20")!;
const kits = demoScript("demo-event-kits", "welcome-20")!;

test("opens without signing in, states the four-part line and where a person takes over", async ({ page }) => {
  const res = await page.goto("/demo");
  expect(res!.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "See the complete flow" })).toBeVisible();
  for (const part of ["AI proposes.", "Code prices.", "PayPal holds.", "The shop decides."]) await expect(page.getByText(part, { exact: true })).toBeVisible();
  await expect(page.getByText("Human approval begins here.")).toBeVisible();
  await expect(page.getByText("A person decides from here")).toBeVisible();
  await expect(page.getByText("This is a sandbox demo with synthetic data. Nothing real is charged.")).toBeVisible();
});

test("offers a button for each demo shop that exists, with the message it sends and the stock story from the engine", async ({ page }) => {
  await page.goto("/demo");
  const giftCard = page.locator('[data-store="demo-gift-boxes"]');
  await expect(giftCard.getByRole("button", { name: "20 welcome boxes" })).toBeVisible();
  await expect(giftCard.getByText(gift.message)).toBeVisible();
  await expect(giftCard.getByText(gift.change.message)).toBeVisible();
  await expect(giftCard).toContainText("$35.00 each, $700.00 in total");
  await expect(giftCard).toContainText("24 of the steel water bottle in stock");
  await expect(giftCard).toContainText("$36.00 each, $1,080.00 in total");

  const kitCard = page.locator('[data-store="demo-event-kits"]');
  await expect(kitCard.getByRole("button", { name: "20 welcome kits" })).toBeVisible();
  await expect(kitCard).toContainText("$33.50 each, $670.00 in total");
  await expect(kitCard).toContainText("$29.50 each, $1,475.00 in total");
});

test("pressing a button starts the real flow: the order room opens with the prepared message sent", async ({ page }) => {
  await page.goto("/demo");
  await page.locator('[data-store="demo-gift-boxes"]').getByRole("button", { name: "20 welcome boxes" }).click();
  await expect(page).toHaveURL(/\/o\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Conversation" }).getByText(gift.message)).toBeVisible();
});

test("the other shop's button starts its own flow", async ({ page }) => {
  await page.goto("/demo");
  await page.locator('[data-store="demo-event-kits"]').getByRole("button", { name: "20 welcome kits" }).click();
  await expect(page).toHaveURL(/\/o\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Conversation" }).getByText(kits.message)).toBeVisible();
});

test("posts to /demo are limited per address (each reaches the model); viewing the page is not", async ({ request }) => {
  const headers = { "x-forwarded-for": `100.68.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}` };
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await request.post("/demo", { headers, data: "" })).status());
  expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
  expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
  expect((await request.get("/demo", { headers })).status()).toBe(200);
});

test("the words on screen make no unmeasured claim, use no system word and print no password", async ({ page }) => {
  await page.goto("/demo");
  // The shop list streams in after the rest of the page: wait for it, or the scan could read a page without it.
  await expect(page.getByRole("button", { name: "20 welcome kits" })).toBeVisible();
  let text = await page.locator("main").innerText();
  expect(claimsIn(text)).toEqual([]);
  // The prepared messages are quoted customer text ("please" is natural there); the vocabulary rule is for the page's own words.
  for (const quoted of await page.locator("main blockquote").allInnerTexts()) text = text.split(quoted).join("");
  expect(forbiddenIn(text)).toEqual([]);
  expect(text).not.toMatch(/password:|passwd|secret|token/i);
});

test("links go to the explanation, the developer page, the interface file, the code and the proof file", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("link", { name: "How it stays safe" })).toHaveAttribute("href", "/how-it-works");
  await expect(page.getByRole("link", { name: "For agent developers" })).toHaveAttribute("href", "/developers");
  await expect(page.getByRole("link", { name: "Agent interface description" })).toHaveAttribute("href", "/api/agent/v1/openapi.json");
  await expect(page.getByRole("link", { name: "The code" })).toHaveAttribute("href", /github\.com\/.+\/OrderForge$/);
  await expect(page.getByRole("link", { name: "The proof file" })).toHaveAttribute("href", /doc\/evidence\/proof-points\.md$/);
  await expect(page.getByRole("link", { name: "Shop sign in" })).toHaveAttribute("href", "/merchant");
});

test("the home page links to it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "See the complete flow" }).click();
  await expect(page).toHaveURL(/\/demo$/);
});

test("at phone width the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/demo");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
