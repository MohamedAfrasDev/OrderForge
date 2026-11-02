import { describe, expect, it, vi } from "vitest";
import { handleHealth } from "@/lib/health";
import { handleReconcile, type ReconcileDeps } from "@/lib/cron/reconcile-handler";
import type { AuditRow } from "@/lib/audit";

const SECRET = "cron-secret-with-plenty-of-length-0123";

function makeDeps(overrides: Partial<ReconcileDeps> = {}) {
  const rows: AuditRow[] = [];
  const insertAudit = vi.fn(async (row: AuditRow) => void rows.push(row));
  const deps: ReconcileDeps = { cronSecret: SECRET, insertAudit, ...overrides };
  return { deps, rows, insertAudit };
}

const post = (headers: Record<string, string> = {}, url = "http://localhost/api/cron/reconcile") =>
  new Request(url, { method: "POST", headers, body: "{}" });

const bearer = (value = SECRET) => ({ authorization: `Bearer ${value}` });

describe("reconcile route authentication", () => {
  it("rejects a request with no credentials, and does nothing", async () => {
    const { deps, rows } = makeDeps();
    const response = await handleReconcile(post(), deps);
    expect(response.status).toBe(401);
    expect(rows).toHaveLength(0);
  });

  it.each([
    ["the wrong secret", { authorization: "Bearer not-the-secret-at-all-0123456789abcd" }],
    ["a secret that is a prefix of the real one", { authorization: `Bearer ${SECRET.slice(0, -1)}` }],
    ["the real secret with something appended", { authorization: `Bearer ${SECRET}x` }],
    ["the wrong scheme", { authorization: `Basic ${SECRET}` }],
    ["no scheme", { authorization: SECRET }],
    ["an empty bearer", { authorization: "Bearer " }],
    ["a lowercase scheme that carries the wrong secret", { authorization: "bearer wrong-wrong-wrong-wrong-1234" }],
  ])("rejects %s", async (_label, headers) => {
    const { deps, rows } = makeDeps();
    const response = await handleReconcile(post(headers), deps);
    expect(response.status).toBe(401);
    expect(rows).toHaveLength(0);
  });

  it("ignores a secret passed in the query string or another header", async () => {
    const { deps, rows } = makeDeps();
    const viaQuery = await handleReconcile(post({}, `http://localhost/api/cron/reconcile?secret=${SECRET}`), deps);
    const viaHeader = await handleReconcile(post({ "x-cron-secret": SECRET }), deps);
    expect(viaQuery.status).toBe(401);
    expect(viaHeader.status).toBe(401);
    expect(rows).toHaveLength(0);
  });

  it("does not reveal why it said no", async () => {
    const { deps } = makeDeps();
    const none = await (await handleReconcile(post(), deps)).text();
    const wrong = await (await handleReconcile(post(bearer("wrong-wrong-wrong-wrong-wrong")), deps)).text();
    expect(none).toBe(wrong);
    expect(none).not.toContain(SECRET);
  });

  it("refuses everything when the server has no usable secret configured", async () => {
    const { deps } = makeDeps({ cronSecret: "" });
    expect((await handleReconcile(post({ authorization: "Bearer " }), deps)).status).toBe(401);
    expect((await handleReconcile(post(bearer("")), deps)).status).toBe(401);
  });

  it("accepts the right secret", async () => {
    const { deps } = makeDeps();
    expect((await handleReconcile(post(bearer()), deps)).status).toBe(200);
  });
});

describe("reconcile heartbeat", () => {
  it("writes one redacted audit event for an authorized run", async () => {
    const { deps, rows } = makeDeps();
    const response = await handleReconcile(post({ ...bearer(), "x-correlation-id": "cron-run-12345678" }), deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(rows).toEqual([
      {
        actor: "system:cron",
        action: "reconcile.heartbeat",
        entity: "system",
        entity_id: "reconcile",
        correlation_id: "cron-run-12345678",
        data: { status: "ok" },
      },
    ]);
  });

  it("mints a correlation id when the caller sends none", async () => {
    const { deps, rows } = makeDeps();
    await handleReconcile(post(bearer()), deps);
    expect(rows[0].correlation_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("is safe to call repeatedly: every run succeeds and none throws", async () => {
    const { deps, rows } = makeDeps();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await handleReconcile(post(bearer()), deps)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    expect(rows).toHaveLength(5);
  });

  it("is safe under simultaneous calls", async () => {
    const { deps } = makeDeps();
    const responses = await Promise.all(Array.from({ length: 10 }, () => handleReconcile(post(bearer()), deps)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
  });

  it("reports failure (so the scheduler's run log shows it) when the audit write fails, without leaking detail", async () => {
    const { deps } = makeDeps({
      insertAudit: vi.fn(async () => {
        throw new Error("connection refused to db.internal:5432 with password hunter2");
      }),
    });
    const response = await handleReconcile(post(bearer()), deps);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe(JSON.stringify({ error: "heartbeat_failed" }));
    expect(text).not.toContain("hunter2");
  });

  it("never caches its answers", async () => {
    const { deps } = makeDeps();
    expect((await handleReconcile(post(bearer()), deps)).headers.get("cache-control")).toContain("no-store");
    expect((await handleReconcile(post(), deps)).headers.get("cache-control")).toContain("no-store");
  });
});

describe("health", () => {
  const healthy = { checkEnv: () => true, checkDatabase: async () => true };

  it("is 200 and ok when everything works", async () => {
    const response = await handleHealth(healthy);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", sandbox: true, checks: { env: "ok", database: "ok" } });
  });

  it("is 503 and degraded when the environment is invalid", async () => {
    const response = await handleHealth({ ...healthy, checkEnv: () => false });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "degraded", checks: { env: "fail", database: "skipped" } });
  });

  it("is 503 when the database check says no", async () => {
    const response = await handleHealth({ ...healthy, checkDatabase: async () => false });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ checks: { env: "ok", database: "fail" } });
  });

  it("is 503, without leaking the error, when a check throws", async () => {
    const response = await handleHealth({
      ...healthy,
      checkDatabase: async () => {
        throw new Error("password authentication failed for user postgres at 10.0.0.5");
      },
    });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain("password");
    expect(text).not.toContain("10.0.0.5");
    expect(JSON.parse(text)).toMatchObject({ checks: { database: "fail" } });
  });

  it("checks the database only if the environment is usable", async () => {
    const checkDatabase = vi.fn(async () => true);
    const response = await handleHealth({ checkEnv: () => false, checkDatabase });
    expect(checkDatabase).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ checks: { env: "fail", database: "skipped" } });
  });

  it("exposes only the documented keys", async () => {
    const body = await (await handleHealth(healthy)).json();
    expect(Object.keys(body).sort()).toEqual(["checks", "sandbox", "status"]);
    expect(Object.keys(body.checks).sort()).toEqual(["database", "env"]);
  });

  it("never caches", async () => {
    expect((await handleHealth(healthy)).headers.get("cache-control")).toContain("no-store");
  });
});
