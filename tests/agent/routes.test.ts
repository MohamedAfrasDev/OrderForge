// The HTTP layer of the agent API with a fake service: status codes, body limits, headers, the bearer token, and that nothing leaks.
import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  bearerToken,
  handleCreateRequest,
  handleDescribeStore,
  handleListStores,
  handleOpenApi,
  handleReadRequest,
  type AgentApiDeps,
  type AgentApiService,
} from "@/lib/agent-api/handlers";
import { createdSchema, errorSchema, openApiDocument, requestViewSchema, storeDescriptionSchema, storeListSchema } from "@/lib/agent-api/schemas";

const PROPOSAL = { kind: "BOX" as const, lines: [{ slotId: "gift", sku: "BOT-01", name: "Water bottle", unitPriceMinor: 1300, quantity: 1 }], perBoxMinor: 3500, totalMinor: 70000, boxCount: 20, currency: "USD" as const };
const CREATED = { requestId: "5b0e6a3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b", status: "CONFIGURING" as const, humanToken: "HUMAN.TOKEN", requestToken: "AGENT.TOKEN", proposalStatus: "VALID" as const, proposals: [PROPOSAL], blockers: [] };

type Calls = { created: unknown[]; read: Array<[string, string | undefined]> };
function fakeService(over: Partial<AgentApiService> = {}): { service: AgentApiService; calls: Calls } {
  const calls: Calls = { created: [], read: [] };
  const service: AgentApiService = {
    listStores: async () => [{ slug: "demo-gift-boxes", name: "Demo Gift Boxes (simulated)", kind: "gift box" }],
    describeStore: async (slug) => (slug === "demo-gift-boxes" ? { slug, name: "Demo Gift Boxes (simulated)", kind: "gift box", parts: [{ id: "gift", label: "Gift item" }] } : null),
    create: async (slug, body) => {
      calls.created.push([slug, body]);
      return slug === "demo-gift-boxes" ? { ok: true, value: CREATED } : { ok: false, code: "NOT_FOUND" };
    },
    read: async (id, token) => {
      calls.read.push([id, token]);
      return token === "AGENT.TOKEN" ? { ok: true, value: { requestId: id, status: "CONFIGURING", proposalStatus: "VALID", proposals: [PROPOSAL], blockers: [], missing: [] } } : { ok: false, code: "NOT_FOUND" };
    },
    ...over,
  };
  return { service, calls };
}
const deps = (service: AgentApiService): AgentApiDeps => ({ service, baseUrl: "https://shop.example/" });

const post = (body: BodyInit | null, headers: Record<string, string> = { "content-type": "application/json" }) => new Request("https://shop.example/api/agent/v1/stores/demo-gift-boxes/requests", { method: "POST", body, headers });
const VALID = JSON.stringify({ boxCount: 20, noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000 });

const expectHardened = (res: Response) => {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-type")).toContain("application/json");
};

describe("GET /stores", () => {
  it("lists the shops, marked simulated, with links, and matches the schema", async () => {
    const res = await handleListStores(deps(fakeService().service));
    expect(res.status).toBe(200);
    expectHardened(res);
    const body = storeListSchema.parse(await res.json());
    expect(body.stores[0]).toMatchObject({ slug: "demo-gift-boxes", simulated: true, links: { describe: "/api/agent/v1/stores/demo-gift-boxes", createRequest: "/api/agent/v1/stores/demo-gift-boxes/requests" } });
  });
});

describe("GET /stores/{slug}", () => {
  it("describes the five fields, says no free text and that a human approves payment, and matches the schema", async () => {
    const res = await handleDescribeStore(deps(fakeService().service), "demo-gift-boxes");
    expect(res.status).toBe(200);
    const body = storeDescriptionSchema.parse(await res.json());
    expect(body.request.fields.map((f) => f.name)).toEqual(["boxCount", "noFood", "logoRequired", "maxPricePerBoxMinor", "requestedPickupDate"]);
    expect(body.request.freeText).toBe(false);
    expect(body.payment.approvedBy).toBe("human");
    expect(body.currency).toBe("USD");
  });

  it("is 404 for an unknown shop", async () => {
    const res = await handleDescribeStore(deps(fakeService().service), "nope");
    expect(res.status).toBe(404);
    expect(errorSchema.parse(await res.json())).toEqual({ error: { code: "NOT_FOUND" } });
  });
});

describe("POST /stores/{slug}/requests", () => {
  it("201 with the request, the box, a human link built from the app address, and the read token; passes the parsed body on", async () => {
    const { service, calls } = fakeService();
    const res = await handleCreateRequest(deps(service), post(VALID), "demo-gift-boxes");
    expect(res.status).toBe(201);
    expectHardened(res);
    const body = createdSchema.parse(await res.json());
    expect(body.humanUrl).toBe("https://shop.example/o/HUMAN.TOKEN");
    expect(body.requestToken).toBe("AGENT.TOKEN");
    expect(body.request).toMatchObject({ id: CREATED.requestId, proposalStatus: "VALID" });
    expect(body.request.proposals[0]).toMatchObject({ perBoxMinor: 3500, totalMinor: 70000 });
    expect(calls.created).toEqual([["demo-gift-boxes", { boxCount: 20, noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000 }]]);
  });

  it("the human token appears only in the link, not as a separate field", async () => {
    const text = JSON.stringify(await (await handleCreateRequest(deps(fakeService().service), post(VALID), "demo-gift-boxes")).json());
    expect(text.match(/HUMAN\.TOKEN/g)).toHaveLength(1);
  });

  it("404 for an unknown shop", async () => {
    const res = await handleCreateRequest(deps(fakeService().service), post(VALID), "nope");
    expect(res.status).toBe(404);
  });

  it("415 when the body is not declared as JSON, and nothing reaches the service", async () => {
    const { service, calls } = fakeService();
    for (const headers of [{}, { "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }] as Array<Record<string, string>>) {
      expect((await handleCreateRequest(deps(service), post(VALID, headers), "demo-gift-boxes")).status).toBe(415);
    }
    expect(calls.created).toEqual([]);
  });

  it("accepts a content type with a charset", async () => {
    const res = await handleCreateRequest(deps(fakeService().service), post(VALID, { "content-type": "application/json; charset=utf-8" }), "demo-gift-boxes");
    expect(res.status).toBe(201);
  });

  it("400 INVALID_JSON for a body that is not JSON, and nothing reaches the service", async () => {
    const { service, calls } = fakeService();
    for (const bad of ["", "not json", "{", "{'a':1}"]) {
      const res = await handleCreateRequest(deps(service), post(bad), "demo-gift-boxes");
      expect(res.status, bad).toBe(400);
      expect(errorSchema.parse(await res.json()).error.code).toBe("INVALID_JSON");
    }
    expect(calls.created).toEqual([]);
  });

  it("413 for a body over the limit, by the declared length and by the real one", async () => {
    const { service, calls } = fakeService();
    const big = JSON.stringify({ boxCount: 20, note: "x".repeat(MAX_BODY_BYTES) });
    expect((await handleCreateRequest(deps(service), post(big), "demo-gift-boxes")).status).toBe(413);
    const lying = new Request("https://shop.example/x", { method: "POST", body: big, headers: { "content-type": "application/json", "content-length": "10" } });
    expect((await handleCreateRequest(deps(service), lying, "demo-gift-boxes")).status).toBe(413);
    expect(calls.created).toEqual([]);
  });

  it("400 INVALID_INPUT with the service's coded issues", async () => {
    const service = fakeService({ create: async () => ({ ok: false, code: "INVALID_INPUT", issues: [{ field: "price", code: "unknown_key" }] }) }).service;
    const res = await handleCreateRequest(deps(service), post(VALID), "demo-gift-boxes");
    expect(res.status).toBe(400);
    expect(errorSchema.parse(await res.json())).toEqual({ error: { code: "INVALID_INPUT", issues: [{ field: "price", code: "unknown_key" }] } });
  });
});

describe("GET /requests/{id}", () => {
  const req = (auth?: string, url = "https://shop.example/api/agent/v1/requests/5b0e6a3a") => new Request(url, { headers: auth ? { authorization: auth } : {} });

  it("200 with the right bearer token, matching the schema", async () => {
    const res = await handleReadRequest(deps(fakeService().service), req("Bearer AGENT.TOKEN"), CREATED.requestId);
    expect(res.status).toBe(200);
    expectHardened(res);
    expect(requestViewSchema.parse(await res.json()).request).toMatchObject({ id: CREATED.requestId, proposalStatus: "VALID", missing: [] });
  });

  it("404 for a missing, wrong, malformed or non-bearer authorization, all with the same body", async () => {
    const { service } = fakeService();
    const bodies = new Set<string>();
    for (const auth of [undefined, "Bearer WRONG", "Basic AGENT.TOKEN", "bearer AGENT.TOKEN", "Bearer ", "Bearer a b", `Bearer ${"x".repeat(700)}`]) {
      const res = await handleReadRequest(deps(service), req(auth), CREATED.requestId);
      expect(res.status, String(auth)).toBe(404);
      bodies.add(JSON.stringify(await res.json()));
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: { code: "NOT_FOUND" } })]);
  });

  it("never takes the token from the address", async () => {
    const { service, calls } = fakeService();
    const res = await handleReadRequest(deps(service), req(undefined, "https://shop.example/api/agent/v1/requests/x?token=AGENT.TOKEN&access_token=AGENT.TOKEN"), CREATED.requestId);
    expect(res.status).toBe(404);
    expect(calls.read).toEqual([[CREATED.requestId, undefined]]);
  });
});

describe("bearerToken", () => {
  it("reads only a well-formed Bearer header", () => {
    expect(bearerToken(new Request("https://x", { headers: { authorization: "Bearer abc.DEF-1_2~3" } }))).toBe("abc.DEF-1_2~3");
    expect(bearerToken(new Request("https://x", { headers: { authorization: "Bearer a b" } }))).toBeUndefined();
    expect(bearerToken(new Request("https://x"))).toBeUndefined();
  });
});

describe("the OpenAPI document", () => {
  it("is served as JSON and describes the four operations", async () => {
    const res = handleOpenApi();
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, Record<string, unknown>> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).sort()).toEqual(["/api/agent/v1/requests/{id}", "/api/agent/v1/stores", "/api/agent/v1/stores/{slug}", "/api/agent/v1/stores/{slug}/requests"]);
  });

  it("describes the request body with exactly the five fields and no extra keys allowed", () => {
    const doc = openApiDocument() as { paths: Record<string, { post?: { requestBody: { content: { "application/json": { schema: { properties: Record<string, unknown>; additionalProperties?: boolean; required: string[] } } } } } }> };
    const schema = doc.paths["/api/agent/v1/stores/{slug}/requests"]!.post!.requestBody.content["application/json"].schema;
    expect(Object.keys(schema.properties).sort()).toEqual(["boxCount", "logoRequired", "maxPricePerBoxMinor", "noFood", "requestedPickupDate"]);
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(["boxCount", "logoRequired", "maxPricePerBoxMinor", "noFood"]);
  });

  it("documents the read-only bearer token, and every error status the handlers return", () => {
    const text = JSON.stringify(openApiDocument());
    for (const status of ["400", "404", "413", "415", "429"]) expect(text).toContain(`"${status}"`);
    expect(text).toContain("bearer");
  });
});
