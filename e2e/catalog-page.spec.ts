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

test.describe("catalog page (local Supabase)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

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

  test("lists products with price, food flag and available stock, and shows the box template, read-only", async ({ page }) => {
    await page.goto("/merchant/login");
    await page.getByLabel("Email").fill(process.env.E2E_MERCHANT_EMAIL!);
    await page.getByLabel("Password").fill(process.env.E2E_MERCHANT_PASSWORD!);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/merchant$/);

    // Reachable from the merchant home.
    await page.getByRole("link", { name: "Catalog" }).click();
    await expect(page).toHaveURL(/\/merchant\/catalog$/);
    await expect(page.getByRole("heading", { name: "Catalog", level: 1 })).toBeVisible();

    const bottle = page.getByRole("row", { name: /BOTTLE-STEEL/ });
    await expect(bottle).toContainText("Steel water bottle");
    await expect(bottle).toContainText("$13.00");
    await expect(bottle.getByRole("cell").last()).toHaveText("24");
    await expect(bottle).not.toContainText("Food");

    const truffles = page.getByRole("row", { name: /TRUFFLES-BOX/ });
    await expect(truffles).toContainText("$8.00");
    await expect(truffles).toContainText("Food");
    await expect(page.getByRole("row", { name: /ORGANIZER-DESK/ }).getByRole("cell").last()).toHaveText("100");

    const template = page.getByRole("region", { name: "Box template" });
    await expect(template.getByRole("listitem")).toHaveCount(5);
    await expect(template.getByRole("listitem").filter({ hasText: "Gift item" })).toContainText("Steel water bottle");
    await expect(template.getByRole("listitem").filter({ hasText: "Gift item" })).toContainText("Chocolate truffles");
    await expect(template.getByRole("listitem").filter({ hasText: "Branded card" })).toContainText("Logo");
    await expect(page.getByText("Production lead time: 7 days")).toBeVisible();

    // Read-only: nothing to submit or type into on this page. (Only visible elements: Next keeps the previous route, here the login form, hidden in the DOM.)
    await expect(page.locator("main input:visible, main textarea:visible, main select:visible, main form:visible")).toHaveCount(0);
  });
});
