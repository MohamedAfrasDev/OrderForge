import { expect, test } from "@playwright/test";

for (const path of ["/", "/does-not-exist"]) {
  test(`sandbox banner is visible on ${path}`, async ({ page }) => {
    await page.goto(path);
    const banner = page.getByRole("status", { name: "Sandbox notice" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Sandbox · simulated data");
  });
}

test("landing page links to the shop's sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "OrderForge" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Shop sign in" })).toHaveAttribute(
    "href",
    "/merchant",
  );
});
