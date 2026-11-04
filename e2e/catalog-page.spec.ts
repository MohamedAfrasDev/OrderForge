import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { boxTemplate, products, stock } from "../supabase/seed/fixtures";

const PAGE = "/merchant/catalog";
const needsLocalSupabase = process.env.E2E_LOCAL_SUPABASE !== "1";

test("the catalog page is merchant-only: a visitor with no session is sent to the login page", async ({ page }) => {
  await page.goto(PAGE);
  await expect(page).toHaveURL(/\/merchant\/login$/);
  await expect(page.getByRole("heading", { name: "Catalog" })).toHaveCount(0);
});

test("the customer pages do not load any AG Grid code", async ({ page }) => {
  const scripts: string[] = [];
  page.on("response", async (response) => {
    if (response.request().resourceType() === "script") scripts.push(await response.text().catch(() => ""));
  });
  for (const path of ["/", "/store/nothing-here"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.filter((code) => /ag-grid|AG Grid/i.test(code))).toHaveLength(0);
});

test.describe("catalog page (local Supabase)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");
  // One worker for the whole describe: the seeding below runs once and the tests share it.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    // Give this run's throwaway merchant the demo catalog. The merchant is new on every run.
    const db = createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const found = await db.from("merchants").select("id").eq("slug", process.env.E2E_STORE_SLUG!).single();
    if (found.error) throw new Error(`merchant lookup: ${found.error.message}`);
    const merchantId = found.data.id as string;

    const ids = new Map(products.map((p) => [p.id, randomUUID()]));
    const rows = products.map((p) => ({ ...p, id: ids.get(p.id)!, merchant_id: merchantId }));
    const inserted = await db.from("products").insert(rows);
    if (inserted.error) throw new Error(`products: ${inserted.error.message}`);
    const stocked = await db.from("stock").insert(stock.map((s) => ({ ...s, product_id: ids.get(s.product_id)! })));
    if (stocked.error) throw new Error(`stock: ${stocked.error.message}`);
    const rule = await db
      .from("business_rules")
      .insert([
        { merchant_id: merchantId, key: "box_template", value: boxTemplate },
        { merchant_id: merchantId, key: "production_lead_days", value: { days: 7 } },
      ]);
    if (rule.error) throw new Error(`rules: ${rule.error.message}`);
  });

  test("lists products with price, food flag and available stock, and shows the box template", async ({ page }) => {
    await page.goto("/merchant/login");
    await page.getByLabel("Email").fill(process.env.E2E_MERCHANT_EMAIL!);
    await page.getByLabel("Password").fill(process.env.E2E_MERCHANT_PASSWORD!);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/merchant$/);

    // Reachable from the merchant home.
    await page.getByRole("link", { name: "Catalog" }).click();
    await expect(page).toHaveURL(/\/merchant\/catalog$/);
    await expect(page.getByRole("heading", { name: "Catalog", level: 1 })).toBeVisible();

    const grid = page.getByRole("grid", { name: "Products" });
    await expect(grid).toBeVisible();
    const bottle = grid.getByRole("row", { name: /BOTTLE-STEEL/ });
    await expect(bottle).toContainText("Steel water bottle");
    await expect(bottle).toContainText("$13.00");
    await expect(bottle.getByRole("gridcell").last()).toHaveText("24"); // available = on hand minus held
    await expect(bottle.locator('[col-id="isFood"]')).toHaveText("No");

    const truffles = grid.getByRole("row", { name: /TRUFFLES-BOX/ });
    await expect(truffles).toContainText("$8.00");
    await expect(truffles.locator('[col-id="isFood"]')).toHaveText("Yes");
    await expect(grid.getByRole("row", { name: /ORGANIZER-DESK/ }).getByRole("gridcell").last()).toHaveText("100");
    // on hand and held are shown too (nothing is held in this fixture)
    await expect(bottle.getByRole("gridcell", { name: "24" })).toHaveCount(2);

    const template = page.getByRole("region", { name: "Box template" });
    await expect(template.getByRole("listitem")).toHaveCount(5);
    await expect(template.getByRole("listitem").filter({ hasText: "Gift item" })).toContainText("Steel water bottle");
    await expect(template.getByRole("listitem").filter({ hasText: "Gift item" })).toContainText("Chocolate truffles");
    await expect(template.getByRole("listitem").filter({ hasText: "Branded card" })).toContainText("Logo");
    await expect(page.getByText("Production lead time: 7 days")).toBeVisible();

    await expect(page.getByRole("searchbox", { name: "Search products" })).toBeVisible();
  });

  test("sorts by price, filters with the search box, and moves with the keyboard", async ({ page }) => {
    await page.goto("/merchant/login");
    await page.getByLabel("Email").fill(process.env.E2E_MERCHANT_EMAIL!);
    await page.getByLabel("Password").fill(process.env.E2E_MERCHANT_PASSWORD!);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/merchant$/);
    await page.goto(PAGE);
    const grid = page.getByRole("grid", { name: "Products" });
    await expect(grid.getByRole("row", { name: /BOTTLE-STEEL/ })).toBeVisible();

    // Sorted by price, cheapest first: the welcome card at $2.00 leads; descending, the desk organizer at $14.00.
    await grid.getByRole("columnheader", { name: /Price/ }).click();
    const firstRow = grid.locator('.ag-row[row-index="0"]'); // the row shown first, wherever the sort puts it
    await expect(firstRow).toContainText("CARD-BRANDED");
    await grid.getByRole("columnheader", { name: /Price/ }).click(); // descending
    await expect(firstRow).toContainText("ORGANIZER-DESK");

    // The search box narrows the rows.
    await page.getByRole("searchbox", { name: "Search products" }).fill("bottle");
    await expect(grid.getByRole("row", { name: /BOTTLE-STEEL/ })).toBeVisible();
    await expect(grid.getByRole("row", { name: /PEN-BLK/ })).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Search products" }).fill("");
    await expect(grid.getByRole("row", { name: /PEN-BLK/ })).toBeVisible();

    // Keyboard: a focused cell moves down with the arrow key.
    await grid.getByRole("gridcell").first().click();
    const rowOfFocus = () => page.locator(".ag-cell-focus").evaluate((cell) => cell.closest(".ag-row")?.getAttribute("row-index") ?? null);
    const before = await rowOfFocus();
    expect(before).not.toBeNull();
    await page.keyboard.press("ArrowDown");
    expect(await rowOfFocus()).not.toBe(before);
  });

  test("at phone width the page does not scroll sideways (the grid scrolls inside itself)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/merchant/login");
    await page.getByLabel("Email").fill(process.env.E2E_MERCHANT_EMAIL!);
    await page.getByLabel("Password").fill(process.env.E2E_MERCHANT_PASSWORD!);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/merchant$/);
    await page.goto(PAGE);
    await expect(page.getByRole("grid", { name: "Products" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
