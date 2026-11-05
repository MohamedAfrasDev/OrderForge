// The shop edits and adds products on the catalog grid, in a real browser against the LOCAL Supabase stack (stand-in data).
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { adminClient, createSeller, needsLocalSupabase, signIn, type Seller } from "./payments-support";

test.describe.configure({ mode: "serial" });

test.describe("the shop's catalog editor (local Supabase)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  let seller: Seller;
  let productId: Record<string, string>;

  test.beforeAll(async () => {
    db = adminClient();
    seller = await createSeller(db, "cat");
    const rows = (await db.from("products").select("id, sku").eq("merchant_id", seller.merchantId)).data ?? [];
    productId = Object.fromEntries(rows.map((r) => [r.sku as string, r.id as string]));
  });

  const open = async (page: Page) => {
    await signIn(page, seller);
    await page.goto("/merchant/catalog");
    await expect(page.getByRole("grid", { name: "Products" })).toBeVisible();
  };
  const rowOf = (page: Page, sku: string) => page.getByRole("grid", { name: "Products" }).getByRole("row", { name: new RegExp(sku) });
  const cell = (page: Page, sku: string, col: string) => rowOf(page, sku).locator(`[col-id="${col}"]`);
  const dbRow = async (sku: string) => (await db.from("products").select("name, category, unit_price_minor, is_food, active").eq("id", productId[sku]!).single()).data!;
  const message = (page: Page) => page.getByTestId("grid-edit-message");

  /** Double-click a Yes/No cell and choose from its list. */
  async function choose(page: Page, sku: string, col: string, label: "Yes" | "No") {
    await cell(page, sku, col).dblclick();
    await cell(page, sku, col).getByRole("combobox").click();
    await page.getByRole("option", { name: label, exact: true }).click();
  }

  /** Double-click a cell, replace what is in it, and press Enter. */
  async function typeInto(page: Page, target: Locator, text: string) {
    await target.dblclick();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  }

  test("a price typed in dollars is saved in cents and the row shows it, also after a reload", async ({ page }) => {
    await open(page);
    await expect(cell(page, "PEN-BLK", "priceMinor")).toHaveText("$3.00");
    await typeInto(page, cell(page, "PEN-BLK", "priceMinor"), "3.50");
    await expect(cell(page, "PEN-BLK", "priceMinor")).toHaveText("$3.50");
    await expect(message(page)).toHaveCount(0);
    await expect.poll(async () => (await dbRow("PEN-BLK")).unit_price_minor).toBe(350);

    await page.reload();
    await expect(cell(page, "PEN-BLK", "priceMinor")).toHaveText("$3.50");
  });

  test("a name changes with the keyboard alone: arrow to the cell, Enter, type, Enter", async ({ page }) => {
    await open(page);
    await cell(page, "PEN-BLK", "sku").click(); // focus a cell of the row
    await page.keyboard.press("ArrowRight"); // the name cell
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Gel pen, black");
    await page.keyboard.press("Enter");
    await expect(cell(page, "PEN-BLK", "name")).toHaveText("Gel pen, black");
    await expect.poll(async () => (await dbRow("PEN-BLK")).name).toBe("Gel pen, black");
  });

  test("a value that is not a price is refused in plain words and the cell is put back", async ({ page }) => {
    await open(page);
    await typeInto(page, cell(page, "CARD-BRANDED", "priceMinor"), "two dollars");
    await expect(message(page)).toContainText("Enter the price in dollars and cents, like 12.50.");
    await expect(cell(page, "CARD-BRANDED", "priceMinor")).toHaveText("$2.00");
    expect((await dbRow("CARD-BRANDED")).unit_price_minor).toBe(200);

    await typeInto(page, cell(page, "CARD-BRANDED", "priceMinor"), "12.505"); // never rounded
    await expect(message(page)).toContainText("dollars and cents");
    expect((await dbRow("CARD-BRANDED")).unit_price_minor).toBe(200);
  });

  test("the last product of a part of the box cannot be switched off, and says which part", async ({ page }) => {
    await open(page);
    await choose(page, "NOTEBOOK-A5", "active", "No");
    await expect(message(page)).toContainText("This is the only product on sale for Notebook.");
    await expect(cell(page, "NOTEBOOK-A5", "active")).toHaveText("Yes");
    expect((await dbRow("NOTEBOOK-A5")).active).toBe(true);
  });

  test("Yes and No columns change with a choice, and another product of a part can be switched off and on", async ({ page }) => {
    await open(page);
    await choose(page, "BOTTLE-STEEL", "active", "No");
    await expect(cell(page, "BOTTLE-STEEL", "active")).toHaveText("No");
    await expect.poll(async () => (await dbRow("BOTTLE-STEEL")).active).toBe(false);

    await choose(page, "BOTTLE-STEEL", "active", "Yes");
    await expect(cell(page, "BOTTLE-STEEL", "active")).toHaveText("Yes");
    await expect.poll(async () => (await dbRow("BOTTLE-STEEL")).active).toBe(true);

    await choose(page, "BOTTLE-STEEL", "isFood", "Yes");
    await expect(cell(page, "BOTTLE-STEEL", "isFood")).toHaveText("Yes");
    await expect.poll(async () => (await dbRow("BOTTLE-STEEL")).is_food).toBe(true);
  });

  test("stock cannot go below what customers hold, and available follows an accepted change", async ({ page }) => {
    await db.from("stock").update({ reserved: 20 }).eq("product_id", productId["ORGANIZER-DESK"]!);
    await open(page);
    await typeInto(page, cell(page, "ORGANIZER-DESK", "onHand"), "10");
    await expect(message(page)).toContainText("Customers are holding 20 of these, so stock cannot go below 20.");
    await expect(cell(page, "ORGANIZER-DESK", "onHand")).toHaveText("100");

    await typeInto(page, cell(page, "ORGANIZER-DESK", "onHand"), "50");
    await expect(cell(page, "ORGANIZER-DESK", "onHand")).toHaveText("50");
    await expect(cell(page, "ORGANIZER-DESK", "available")).toHaveText("30");
    await db.from("stock").update({ reserved: 0 }).eq("product_id", productId["ORGANIZER-DESK"]!);
  });

  test("the code, what is held and what is available cannot be edited", async ({ page }) => {
    await open(page);
    for (const col of ["sku", "held", "available"]) {
      await cell(page, "PEN-BLK", col).dblclick();
      await expect(page.locator(".ag-cell-inline-editing")).toHaveCount(0);
    }
  });

  test("adds a product that goes in the chosen parts of the box, shows in the grid and the template, and keeps its price in cents", async ({ page }) => {
    await open(page);
    const form = page.getByRole("form", { name: "Add a product" });
    await form.getByLabel("Name").fill("Enamel mug");
    await form.getByLabel("Category").fill("drinkware");
    await form.getByLabel("Price (dollars)").fill("9.50");
    await form.getByLabel("How many you have").fill("40");
    await form.getByLabel("Code").fill("MUG-BLUE");
    await form.getByLabel("Gift item").check();
    await form.getByRole("button", { name: "Add product" }).click();
    await expect(page.getByRole("status", { name: "Product added" })).toContainText("Enamel mug was added");

    await expect(cell(page, "MUG-BLUE", "name")).toHaveText("Enamel mug");
    await expect(cell(page, "MUG-BLUE", "priceMinor")).toHaveText("$9.50");
    await expect(cell(page, "MUG-BLUE", "onHand")).toHaveText("40");
    await expect(page.getByRole("region", { name: "Box template" }).getByRole("listitem").filter({ hasText: "Gift item" })).toContainText("Enamel mug");
    const saved = (await db.from("products").select("unit_price_minor, active").eq("merchant_id", seller.merchantId).eq("sku", "MUG-BLUE").single()).data!;
    expect(saved).toEqual({ unit_price_minor: 950, active: true });
  });

  test("an added product is refused in plain words when the code is taken, no part is chosen, or the price is not a price", async ({ page }) => {
    await open(page);
    const form = page.getByRole("form", { name: "Add a product" });
    const fill = async (code: string, price: string) => {
      await form.getByLabel("Name").fill("Another");
      await form.getByLabel("Category").fill("misc");
      await form.getByLabel("Price (dollars)").fill(price);
      await form.getByLabel("How many you have").fill("5");
      await form.getByLabel("Code").fill(code);
    };
    const note = page.getByTestId("add-product-message");

    await fill("PEN-BLK", "1.00");
    await form.getByLabel("Gift item").check();
    await form.getByRole("button", { name: "Add product" }).click();
    await expect(note).toContainText("You already have a product with that code.");

    await fill("NEW-ONE", "1.00");
    await form.getByLabel("Gift item").uncheck();
    await form.getByRole("button", { name: "Add product" }).click();
    await expect(note).toContainText("Choose at least one part of the box");

    await fill("NEW-ONE", "a lot");
    await form.getByLabel("Gift item").check();
    await form.getByRole("button", { name: "Add product" }).click();
    await expect(note).toContainText("Enter the price in dollars and cents");
    expect((await db.from("products").select("id").eq("merchant_id", seller.merchantId).eq("sku", "NEW-ONE")).data).toHaveLength(0);
  });

  test("at phone width the page does not scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);
    await expect(page.getByRole("form", { name: "Add a product" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});
