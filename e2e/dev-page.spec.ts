import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

// The app under test talks to a LOCAL FAKE PayPal (started in global setup), so everything here is
// labeled "mocked". No traffic reaches the real PayPal sandbox.
const PAGE = "/merchant/dev/paypal";
const needsLocalSupabase = process.env.E2E_LOCAL_SUPABASE !== "1";

const db = () =>
  createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SERVICE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

async function signIn(page: Page) {
  await page.goto("/merchant/login");
  await page.getByLabel("Email").fill(process.env.E2E_MERCHANT_EMAIL!);
  await page.getByLabel("Password").fill(process.env.E2E_MERCHANT_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/merchant$/);
}

test("the dev page is merchant-only: a visitor with no session is sent to the login page", async ({ page }) => {
  await page.goto(PAGE);
  await expect(page).toHaveURL(/\/merchant\/login$/);
  await expect(page.getByRole("button", { name: "Create sandbox order" })).toHaveCount(0);
});

test.describe("dev page (local Supabase + fake PayPal)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");
  // These tests write spike events and one of them counts them, so they must not overlap.
  test.describe.configure({ mode: "serial" });

  test("shows which PayPal it talks to and how evidence is labeled", async ({ page }) => {
    await signIn(page);
    await page.goto(PAGE);
    await expect(page.getByRole("heading", { name: "PayPal sandbox spike" })).toBeVisible();
    await expect(page.getByTestId("spike-target")).toHaveText("local fake PayPal (mocked)");
    await expect(page.getByRole("status", { name: "Sandbox notice" })).toBeVisible();
  });

  test("authorize then capture, end to end through the UI", async ({ page }) => {
    await signIn(page);
    await page.goto(PAGE);

    await page.getByRole("button", { name: "Create sandbox order" }).click();
    const orderId = await page.getByTestId("order-id").innerText();
    expect(orderId).toMatch(/^FAKEORDER\d+$/);
    await expect(page.getByRole("link", { name: /Approve in the PayPal sandbox/ })).toHaveAttribute(
      "href",
      new RegExp(`^https://www\\.sandbox\\.paypal\\.com/.*${orderId}`),
    );

    // Before the buyer approves, nothing is authorized.
    await page.getByRole("button", { name: "Authorize, then capture" }).click();
    await expect(page.getByRole("list", { name: "Steps" })).toContainText("not_approved");

    await page.getByRole("button", { name: "Simulate buyer approval (fake PayPal only)" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Simulated the buyer" })).toBeVisible();

    await page.getByRole("button", { name: "Authorize, then capture" }).click();
    const steps = page.getByRole("list", { name: "Steps" });
    await expect(steps).toContainText("authorized");
    await expect(steps).toContainText("captured");
    await expect(steps).toContainText("(mocked)");

    // The evidence is in the database, labeled, attributed to the signed-in merchant.
    const { data: events } = await db().from("payment_events").select("event_type, evidence_label").eq("payload->>order_id", orderId);
    expect(events?.map((e) => e.event_type).sort()).toEqual(["spike.authorized", "spike.captured", "spike.not_approved", "spike.order_created"].sort());
    expect(events?.every((e) => e.evidence_label === "mocked")).toBe(true);
    const { data: audits } = await db().from("audit_events").select("actor").eq("entity_id", orderId);
    expect(audits?.every((a) => a.actor.startsWith("merchant:"))).toBe(true);
  });

  test("authorize then void, and the hold is confirmed released", async ({ page }) => {
    await signIn(page);
    await page.goto(PAGE);
    await page.getByRole("button", { name: "Create sandbox order" }).click();
    await expect(page.getByTestId("order-id")).toBeVisible();
    await page.getByRole("button", { name: "Simulate buyer approval (fake PayPal only)" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Simulated the buyer" })).toBeVisible();

    await page.getByRole("button", { name: "Authorize, then void" }).click();
    await expect(page.getByRole("list", { name: "Steps" })).toContainText("voided");
    await expect(page.getByRole("list", { name: "Steps" })).not.toContainText("captured");
  });

  test("run reconcile now records a heartbeat attributed to the merchant", async ({ page }) => {
    await signIn(page);
    await page.goto(PAGE);
    const before = (await db().from("audit_events").select("id").eq("action", "reconcile.heartbeat").like("actor", "merchant:%")).data?.length ?? 0;

    await page.getByRole("button", { name: "Run reconcile now" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Reconcile heartbeat recorded." })).toBeVisible();

    const after = (await db().from("audit_events").select("id").eq("action", "reconcile.heartbeat").like("actor", "merchant:%")).data?.length ?? 0;
    expect(after).toBe(before + 1);
  });

  test("once the session ends, a click on an open page has no effect", async ({ page, context }) => {
    // Two layers stop this: proxy.ts turns the request away, and every server action re-checks the
    // session itself (tests/dev-actions.test.ts). Either way, nothing may be created.
    await signIn(page);
    await page.goto(PAGE);
    await expect(page.getByRole("button", { name: "Create sandbox order" })).toBeVisible();
    const { count: before } = await db().from("payment_events").select("id", { count: "exact", head: true }).eq("source", "spike");

    await context.clearCookies(); // the session ends while this page is still open
    await page.getByRole("button", { name: "Create sandbox order" }).click();

    // The merchant is either sent to the login page or shown Next's error page, and no order appears.
    await expect(page.locator("html#__next_error__").or(page.getByRole("heading", { name: "Merchant sign in" }))).toBeVisible();
    await expect(page.getByTestId("order-id")).toHaveCount(0);
    const { count: after } = await db().from("payment_events").select("id", { count: "exact", head: true }).eq("source", "spike");
    expect(after).toBe(before);
  });
});
