import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const needsLocalSupabase = process.env.E2E_LOCAL_SUPABASE !== "1";

test.describe("reconcile route", () => {
  test("refuses a caller with no bearer token", async ({ request }) => {
    const response = await request.post("/api/cron/reconcile");
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("refuses the wrong bearer token", async ({ request }) => {
    const response = await request.post("/api/cron/reconcile", {
      headers: { authorization: "Bearer definitely-not-the-cron-secret-000000" },
    });
    expect(response.status()).toBe(401);
  });

  test("only accepts POST", async ({ request }) => {
    expect((await request.get("/api/cron/reconcile")).status()).toBe(405);
  });

  test.describe("with a local Supabase", () => {
    test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

    test("an authorized run succeeds and leaves a heartbeat audit row", async ({ request }) => {
      const correlationId = `e2e-cron-${Date.now()}`;
      const response = await request.post("/api/cron/reconcile", {
        headers: { authorization: `Bearer ${process.env.E2E_CRON_SECRET}`, "x-correlation-id": correlationId },
      });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });

      const db = createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SERVICE_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data } = await db.from("audit_events").select("action, actor, data").eq("correlation_id", correlationId);
      // The run may also record what the sweep and the payments and jobs steps did (for example releasing a hold that expired
      // since an earlier test), so the heartbeat is asserted exactly once and every other row must still be the cron's own.
      const rows = data ?? [];
      expect(rows.filter((r) => r.action === "reconcile.heartbeat")).toEqual([{ action: "reconcile.heartbeat", actor: "system:cron", data: { status: "ok" } }]);
      expect(rows.every((r) => r.actor === "system:cron")).toBe(true);
    });
  });
});

test.describe("health route", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  test("reports ok, with nothing sensitive in the answer", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");

    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: "ok", sandbox: true, checks: { env: "ok", database: "ok" } });
    for (const secret of [process.env.E2E_CRON_SECRET, process.env.E2E_ACCESS_LINK_SECRET, process.env.E2E_SUPABASE_SERVICE_KEY]) {
      expect(text).not.toContain(secret!);
    }
  });
});
