// Real local Postgres. The agent API's handlers wired to the real services: real responses checked against the same schemas the OpenAPI
// document is built from, and the human link in a response really opens the request. No model, no PayPal call.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleCreateRequest, handleDescribeStore, handleListStores, handleReadRequest, type AgentApiDeps } from "@/lib/agent-api/handlers";
import { createdSchema, errorSchema, requestViewSchema, storeDescriptionSchema, storeListSchema } from "@/lib/agent-api/schemas";
import { createAgentApiService } from "@/lib/agent-api/service";
import { authorizeCustomerLink } from "@/lib/access/inquiry-reads";
import { must, serviceClient } from "./helpers";
import { NOW, SECRET } from "./intake-helpers";
import { catalogMerchant } from "./intake-fixtures";

const db = serviceClient();
const clock = { now: () => new Date(NOW), correlationId: () => "corr-agent-api" };
const depsFor = (slugs: string[]): AgentApiDeps => ({ baseUrl: "https://shop.example", service: createAgentApiService(db, { accessSecret: SECRET }, clock, slugs) });

const VALID = { boxCount: 20, noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000 };
const post = (body: unknown) => new Request("https://shop.example/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const get = (token?: string) => new Request("https://shop.example/x", { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("the agent API over the real services", () => {
  it("lists only the shops it was given that exist, with their kind", async () => {
    const m = await catalogMerchant(db);
    const missing = `absent-${randomUUID().slice(0, 8)}`;
    must(await db.from("business_rules").insert({ merchant_id: m.merchantId, key: "shop_profile", value: { productKind: "gift box" } }));
    const res = await handleListStores(depsFor([m.slug, missing]));
    const body = storeListSchema.parse(await res.json());
    expect(body.stores.map((s) => s.slug)).toEqual([m.slug]);
    expect(body.stores[0]).toMatchObject({ kind: "gift box", simulated: true });
  });

  it("describes a shop with its parts of the box, and no stock, price or id", async () => {
    const m = await catalogMerchant(db);
    const res = await handleDescribeStore(depsFor([m.slug]), m.slug);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.clone().json());
    const body = storeDescriptionSchema.parse(await res.json());
    expect(body.parts.map((p) => p.id)).toEqual(["notebook", "pen", "gift", "card", "packaging"]);
    expect(text).not.toMatch(/on_hand|reserved|unitPrice|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it("a shop that exists but is not one of the demo shops is NOT_FOUND on every route, like one that does not exist", async () => {
    const m = await catalogMerchant(db);
    const other = depsFor(["some-other-slug"]);
    expect((await handleDescribeStore(other, m.slug)).status).toBe(404);
    expect((await handleCreateRequest(other, post(VALID), m.slug)).status).toBe(404);
    expect((await handleDescribeStore(other, "nope")).status).toBe(404);
  });

  it("create then read: 20 boxes, $35.00 a box, $700.00; the human link opens the request; the token reads it", async () => {
    const m = await catalogMerchant(db);
    const deps = depsFor([m.slug]);
    const res = await handleCreateRequest(deps, post(VALID), m.slug);
    expect(res.status).toBe(201);
    const created = createdSchema.parse(await res.json());
    expect(created.request.proposals[0]).toMatchObject({ perBoxMinor: 3500, totalMinor: 70_000 });

    const humanToken = created.humanUrl.replace("https://shop.example/o/", "");
    const access = await authorizeCustomerLink(db, humanToken, { secret: SECRET, now: new Date(NOW) });
    expect(access.ok && access.inquiry.id).toBe(created.request.id);

    const read = await handleReadRequest(deps, get(created.requestToken), created.request.id);
    expect(read.status).toBe(200);
    expect(requestViewSchema.parse(await read.json()).request).toMatchObject({ id: created.request.id, proposalStatus: "VALID" });
  });

  it("30 boxes: coded blockers and the swap, with integer cents", async () => {
    const m = await catalogMerchant(db);
    const created = createdSchema.parse(await (await handleCreateRequest(depsFor([m.slug]), post({ ...VALID, boxCount: 30 }), m.slug)).json());
    expect(created.request.proposalStatus).toBe("BLOCKED");
    expect(created.request.blockers).toEqual([{ code: "INSUFFICIENT_STOCK", sku: "BOTTLE-STEEL", needed: 30, available: 24 }]);
    expect(created.request.proposals[0]).toMatchObject({ kind: "SWAP", perBoxMinor: 3600, totalMinor: 108_000 });
  });

  it("invalid bodies are 400 with coded issues, store nothing, and never echo what was sent", async () => {
    const m = await catalogMerchant(db);
    const before = must(await db.from("inquiries").select("id").eq("merchant_id", m.merchantId)).length;
    const secret = "ECHO-CANARY-9f2c";
    const res = await handleCreateRequest(depsFor([m.slug]), post({ ...VALID, price: 1, [secret]: secret, boxCount: secret }), m.slug);
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.clone().json());
    expect(text).not.toContain(secret);
    const body = errorSchema.parse(await res.json());
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.issues?.some((i) => i.field === "price" && i.code === "unknown_key")).toBe(true);
    expect(must(await db.from("inquiries").select("id").eq("merchant_id", m.merchantId))).toHaveLength(before);
  });

  it("one request's token cannot read another's, and a customer link cannot read at all: the same 404", async () => {
    const m = await catalogMerchant(db);
    const deps = depsFor([m.slug]);
    const a = createdSchema.parse(await (await handleCreateRequest(deps, post(VALID), m.slug)).json());
    const b = createdSchema.parse(await (await handleCreateRequest(deps, post(VALID), m.slug)).json());
    const human = a.humanUrl.replace("https://shop.example/o/", "");
    const bodies = new Set<string>();
    for (const token of [b.requestToken, human, "garbage", undefined]) {
      const res = await handleReadRequest(deps, get(token), a.request.id);
      expect(res.status).toBe(404);
      bodies.add(JSON.stringify(await res.json()));
    }
    expect(bodies.size).toBe(1);
    expect((await handleReadRequest(deps, get(a.requestToken), a.request.id)).status).toBe(200);
  });
});
