// Real local Postgres. The daily cap per shop (counted from the audit trail, no table of its own) and what the audit trail says about agent calls:
// the shop, a coded outcome and a short fingerprint of the token, never the token, an address or anything the agent sent.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgentApiService } from "@/lib/agent-api/service";
import { agentRef, createAgentRequest, DEFAULT_DAILY_CAP_PER_STORE } from "@/services/agent-requests";
import { must, serviceClient } from "./helpers";
import { NOW, SECRET, ctx } from "./intake-helpers";
import { catalogMerchant } from "./intake-fixtures";

const db = serviceClient();
const VALID = { boxCount: 20, noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000 };
const inquiriesOf = async (merchantId: string) => must(await db.from("inquiries").select("id").eq("merchant_id", merchantId)).length;

describe("the daily cap per shop", () => {
  it("is 200 by default", () => {
    expect(DEFAULT_DAILY_CAP_PER_STORE).toBe(200);
  });

  it("lets a shop take the cap, then refuses with a retry time and creates nothing", async () => {
    const m = await catalogMerchant(db);
    const deps = { accessSecret: SECRET, dailyCapPerStore: 2 };
    expect((await createAgentRequest(db, deps, m.slug, VALID, ctx)).ok).toBe(true);
    expect((await createAgentRequest(db, deps, m.slug, VALID, ctx)).ok).toBe(true);
    expect(await inquiriesOf(m.merchantId)).toBe(2);

    const third = await createAgentRequest(db, deps, m.slug, VALID, ctx);
    expect(third).toEqual({ ok: false, code: "RATE_LIMITED", retryAfterSeconds: 3600 });
    expect(await inquiriesOf(m.merchantId)).toBe(2);
  });

  it("is counted per shop: one shop reaching its cap does not stop another", async () => {
    const a = await catalogMerchant(db);
    const b = await catalogMerchant(db);
    const deps = { accessSecret: SECRET, dailyCapPerStore: 1 };
    expect((await createAgentRequest(db, deps, a.slug, VALID, ctx)).ok).toBe(true);
    expect((await createAgentRequest(db, deps, a.slug, VALID, ctx)).ok).toBe(false);
    expect((await createAgentRequest(db, deps, b.slug, VALID, ctx)).ok).toBe(true);
  });

  it("counts requests made through the agent interface only: a request a customer made on the shop's page does not use it up", async () => {
    const m = await catalogMerchant(db);
    must(await db.from("inquiries").insert({ merchant_id: m.merchantId }).select("id").single());
    expect((await createAgentRequest(db, { accessSecret: SECRET, dailyCapPerStore: 1 }, m.slug, VALID, ctx)).ok).toBe(true);
  });

  it("counts only the last 24 hours: a day later the shop can take requests again", async () => {
    const m = await catalogMerchant(db);
    const deps = { accessSecret: SECRET, dailyCapPerStore: 1 };
    expect((await createAgentRequest(db, deps, m.slug, VALID, ctx)).ok).toBe(true);
    expect((await createAgentRequest(db, deps, m.slug, VALID, ctx)).ok).toBe(false);
    const nextDay = { ...ctx, now: new Date(Date.now() + 25 * 3_600_000).toISOString() };
    expect((await createAgentRequest(db, deps, m.slug, VALID, nextDay)).ok).toBe(true);
  });

  it("a refused body does not use up the cap", async () => {
    const m = await catalogMerchant(db);
    const deps = { accessSecret: SECRET, dailyCapPerStore: 1 };
    expect((await createAgentRequest(db, deps, m.slug, { ...VALID, price: 1 }, ctx)).ok).toBe(false);
    expect((await createAgentRequest(db, deps, m.slug, VALID, ctx)).ok).toBe(true);
  });
});

describe("what the audit trail says", () => {
  const auditFor = async (correlationId: string) =>
    must(await db.from("audit_events").select("actor, action, entity, entity_id, data").eq("correlation_id", correlationId).order("id")) as Array<{ actor: string; action: string; entity: string; entity_id: string; data: Record<string, unknown> }>;

  function serviceFor(slug: string) {
    const correlationId = `corr-agent-${randomUUID()}`;
    const service = createAgentApiService(db, { accessSecret: SECRET }, { now: () => new Date(NOW), correlationId: () => correlationId }, [slug]);
    return { service, correlationId };
  }

  it("a create is audited with the shop and a fingerprint of the token, and nothing that could be used as a credential", async () => {
    const m = await catalogMerchant(db);
    const { service, correlationId } = serviceFor(m.slug);
    const out = await service.create(m.slug, VALID);
    if (!out.ok) throw new Error("create");

    const rows = await auditFor(correlationId);
    const made = rows.find((r) => r.action === "intake.agent_request_created");
    expect(made).toBeDefined();
    expect(made!.data).toMatchObject({ store: m.slug, agent_ref: agentRef(out.value.requestToken), inquiry_id: out.value.requestId });
    expect(String(made!.data.agent_ref)).toMatch(/^[0-9a-f]{8}$/);

    const all = JSON.stringify(rows);
    expect(all).not.toContain(out.value.requestToken);
    expect(all).not.toContain(out.value.humanToken);
    expect(all).not.toContain(SECRET);
  });

  it("a read is audited with its outcome and the fingerprint of the token it presented", async () => {
    const m = await catalogMerchant(db);
    const { service, correlationId } = serviceFor(m.slug);
    const out = await service.create(m.slug, VALID);
    if (!out.ok) throw new Error("create");

    await service.read(out.value.requestId, out.value.requestToken);
    await service.read(out.value.requestId, "a-wrong-token");
    await service.read(out.value.requestId, undefined);
    await service.read("not-a-uuid", "whatever");

    const reads = (await auditFor(correlationId)).filter((r) => r.action === "agent.request_read");
    expect(reads.map((r) => r.data.outcome)).toEqual(["ok", "NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
    expect(reads.map((r) => r.data.agent_ref)).toEqual([agentRef(out.value.requestToken), agentRef("a-wrong-token"), "none", agentRef("whatever")]);
    expect(reads.map((r) => r.entity_id)).toEqual([out.value.requestId, out.value.requestId, out.value.requestId, "invalid"]);
    const all = JSON.stringify(reads);
    for (const secret of [out.value.requestToken, "a-wrong-token", "whatever"]) expect(all).not.toContain(secret);
  });

  it("a refused create is audited with a coded outcome and no input", async () => {
    const m = await catalogMerchant(db);
    const { service, correlationId } = serviceFor(m.slug);
    const canary = "ECHO-CANARY-77aa";
    await service.create(m.slug, { ...VALID, [canary]: canary });
    await service.create("some-other-shop", VALID);

    const refused = (await auditFor(correlationId)).filter((r) => r.action === "agent.request_refused");
    expect(refused.map((r) => r.data)).toEqual([
      { store: m.slug, outcome: "INVALID_INPUT" },
      { store: "(other)", outcome: "NOT_FOUND" },
    ]);
    expect(JSON.stringify(refused)).not.toContain(canary);
  });

  it("no agent audit line carries an address or an authorization header", async () => {
    const m = await catalogMerchant(db);
    const { service, correlationId } = serviceFor(m.slug);
    const out = await service.create(m.slug, VALID);
    if (!out.ok) throw new Error("create");
    await service.read(out.value.requestId, out.value.requestToken);
    const all = JSON.stringify(await auditFor(correlationId));
    expect(all).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(all.toLowerCase()).not.toContain("bearer");
    expect(all.toLowerCase()).not.toContain("authorization");
  });
});
