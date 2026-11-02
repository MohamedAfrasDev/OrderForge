import { expect, test } from "@playwright/test";

for (const path of ["/", "/does-not-exist"]) {
  test(`sandbox banner is visible on ${path}`, async ({ page }) => {
    await page.goto(path);
    const banner = page.getByRole("status", { name: "Sandbox notice" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Sandbox · simulated data");
  });
}

test("landing page links to the merchant area", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "OrderForge" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Merchant portal" })).toHaveAttribute(
    "href",
    "/merchant",
  );
});
