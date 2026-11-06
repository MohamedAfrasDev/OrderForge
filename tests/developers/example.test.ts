// /developers shows output of the real handler and engine, and its prose makes no claim nobody measured. Drift fails the build.
import { describe, expect, it } from "vitest";
import { FIELDS, handleDescribeStore } from "@/lib/agent-api/handlers";
import { AGENT_LIMITS } from "@/lib/agent-api/limits";
import { createdSchema, openApiDocument, storeDescriptionSchema } from "@/lib/agent-api/schemas";
import { DEVELOPERS, developersText } from "@/lib/developers/content";
import { BLOCKED_BODY, FITS_BODY, contractFields, createCurl, exampleResponse, pretty, readCurl } from "@/lib/developers/example";
import { claimsIn } from "@/lib/claims";
import { agentBodySchema } from "@/services/agent-requests/schema";

const BASE = "https://shop.example";

describe("the contract table", () => {
  it("is the five fields, in the order the store description serves them, with the same required flags and ranges", () => {
    const table = contractFields();
    expect(table.map((f) => f.name)).toEqual(FIELDS.map((f) => f.name));
    expect(table.map((f) => f.required)).toEqual(FIELDS.map((f) => f.required));
    for (const f of FIELDS) {
      const row = table.find((t) => t.name === f.name)!;
      if ("min" in f && "max" in f) expect(row.range).toBe(`${f.min} to ${f.max}`);
      expect(row.description).toBe(f.description);
    }
  });

  it("matches the keys of the schema and the request body in the OpenAPI document", () => {
    const keys = Object.keys(agentBodySchema.shape);
    expect(contractFields().map((f) => f.name)).toEqual(keys);
    const doc = openApiDocument() as { paths: Record<string, { post?: { requestBody: { content: { "application/json": { schema: { properties: Record<string, unknown> } } } } } }> };
    const props = doc.paths["/api/agent/v1/stores/{slug}/requests"]!.post!.requestBody.content["application/json"].schema.properties;
    expect(Object.keys(props)).toEqual(keys);
  });

  it("describes the same fields the live store description returns", async () => {
    const res = await handleDescribeStore({ baseUrl: BASE, service: { listStores: async () => [], describeStore: async (slug) => ({ slug, name: "x", kind: "y", parts: [] }), create: async () => ({ ok: false, code: "NOT_FOUND" }), read: async () => ({ ok: false, code: "NOT_FOUND" }) } }, "demo-gift-boxes");
    expect(storeDescriptionSchema.parse(await res.json()).request.fields.map((f) => f.name)).toEqual(contractFields().map((f) => f.name));
  });
});

describe("the example bodies and the curl", () => {
  it("both pass the route's schema", () => {
    expect(agentBodySchema.safeParse(FITS_BODY).success).toBe(true);
    expect(agentBodySchema.safeParse(BLOCKED_BODY).success).toBe(true);
  });

  it("the curl posts exactly the example body, to the address given", () => {
    const curl = createCurl(BASE, FITS_BODY);
    expect(curl).toContain(`${BASE}/api/agent/v1/stores/demo-gift-boxes/requests`);
    const sent = /-d '(.+)'/.exec(curl)![1]!;
    expect(JSON.parse(sent)).toEqual(FITS_BODY);
    expect(curl).not.toMatch(/Authorization/i);
    expect(readCurl(BASE)).toContain("Authorization: Bearer");
  });
});

describe("the 20-box response", () => {
  it("is 201 from the real handler, passes the response schema, and shows $35.00 a box and $700.00 in cents", async () => {
    const r = await exampleResponse(BASE, FITS_BODY);
    expect(createdSchema.safeParse(r).success).toBe(true);
    expect(r.request.proposalStatus).toBe("VALID");
    expect(r.request.blockers).toEqual([]);
    expect(r.request.proposals).toHaveLength(1);
    expect(r.request.proposals[0]).toMatchObject({ kind: "BOX", perBoxMinor: 3500, totalMinor: 70000, boxCount: 20, currency: "USD" });
    expect(r.request.proposals[0]!.lines.map((l) => l.unitPriceMinor)).toEqual([1200, 300, 1300, 200, 500]);
  });

  it("links a person to the order room on the given address, with placeholders for the id and tokens", async () => {
    const r = await exampleResponse(`${BASE}/`, FITS_BODY);
    expect(r.humanUrl).toBe(`${BASE}/o/example-human-token`);
    expect(r.requestToken).toBe("example-agent-token");
  });

  it("is the same every time (the page does not depend on the clock)", async () => {
    expect(JSON.stringify(await exampleResponse(BASE, FITS_BODY))).toBe(JSON.stringify(await exampleResponse(BASE, FITS_BODY)));
  });
});

describe("the 30-box response", () => {
  it("is blocked with a coded reason and one valid swap, in cents", async () => {
    const r = await exampleResponse(BASE, BLOCKED_BODY);
    expect(createdSchema.safeParse(r).success).toBe(true);
    expect(r.request.proposalStatus).toBe("BLOCKED");
    expect(r.request.blockers).toEqual([{ code: "INSUFFICIENT_STOCK", sku: "BOTTLE-STEEL", needed: 30, available: 24 }]);
    const swap = r.request.proposals.find((p) => p.kind === "SWAP");
    expect(swap).toMatchObject({ perBoxMinor: 3600, totalMinor: 108000, swap: { fromSku: "BOTTLE-STEEL", toSku: "ORGANIZER-DESK" } });
  });
});

describe("pretty", () => {
  it("is the same data as JSON, only laid out shorter", async () => {
    const r = await exampleResponse(BASE, FITS_BODY);
    const text = pretty(r);
    expect(JSON.parse(text)).toEqual(r);
    expect(text.split("\n").length).toBeLessThan(JSON.stringify(r, null, 2).split("\n").length);
  });
});

describe("the prose", () => {
  it("states the rule in the words the spec fixes", () => {
    expect(DEVELOPERS.rule).toBe("The agent can request and read; it cannot accept or pay.");
  });

  it("makes no unmeasured claim, says sandbox and synthetic, and names nothing that does not exist", () => {
    const text = developersText();
    expect(claimsIn(text)).toEqual([]);
    expect(text).toMatch(/sandbox/i);
    expect(text).toMatch(/synthetic/i);
    expect(text).not.toMatch(/\bMCP\b|autonomous|autonomously|\bwebhook/i);
  });

  it("holds no figure that the code owns (limits, prices, ranges are read from the code)", () => {
    expect(developersText()).not.toMatch(/\d/);
    expect(AGENT_LIMITS.createPerAddress).toBeGreaterThan(0);
  });
});
