// The agent API against the running app and the LOCAL Supabase stack. No model is involved (code chooses and prices the box) and no PayPal call is made.
// It uses the second demo shop and only makes sure its rows exist, so it can run next to the specs that use that shop's login and stock.
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { adminClient, needsLocalSupabase } from "./payments-support";
import { ensureKitShop } from "./second-shop-support";

const BODY = { boxCount: 20, noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000 };
const A = "/api/agent/v1";

test.describe("the agent API (local Supabase, no model, no PayPal call)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");

  let db: SupabaseClient;
  test.beforeAll(async () => {
    db = adminClient();
    await ensureKitShop(db);
    // The shop's daily cap is counted from the audit trail, which a local database keeps across runs. Clear this shop's count (LOCAL database only),
    // so many runs in one day never fill it.
    const cleared = await db.from("audit_events").delete().eq("action", "intake.agent_request_created").eq("data->>store", "demo-event-kits");
    if (cleared.error) throw new Error(`clear agent audit: ${cleared.error.message}`);
  });

  // A private address per test, as the other specs do, so a shared address budget is never used up.
  test.beforeEach(async ({ page }) => {
    const a = Math.floor(Math.random() * 250) + 1;
    const b = Math.floor(Math.random() * 250) + 1;
    await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `100.66.${a}.${b}` });
  });
  const headers = () => ({ "x-forwarded-for": `100.67.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}` });

  test("the OpenAPI document is public JSON and describes the four operations", async ({ request }) => {
    const res = await request.get(`${A}/openapi.json`);
    expect(res.status()).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toHaveLength(4);
  });

  test("lists the demo shops, marked simulated, and describes one with its five fields and that a person approves payment", async ({ request }) => {
    const list = await (await request.get(`${A}/stores`, { headers: headers() })).json();
    const kit = list.stores.find((s: { slug: string }) => s.slug === "demo-event-kits");
    expect(kit).toMatchObject({ name: "Demo Event Kits (simulated)", simulated: true });

    const res = await request.get(`${A}/stores/demo-event-kits`, { headers: headers() });
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-store");
    const store = await res.json();
    expect(store.request.fields.map((f: { name: string }) => f.name)).toEqual(["boxCount", "noFood", "logoRequired", "maxPricePerBoxMinor", "requestedPickupDate"]);
    expect(store.payment.approvedBy).toBe("human");
    expect(store.parts.map((p: { id: string }) => p.id)).toEqual(["tote", "lanyard", "drink", "stickers", "packaging"]);
  });

  test("20 kits: a priced box in cents, a link for a person, a token that reads it back", async ({ request }) => {
    const res = await request.post(`${A}/stores/demo-event-kits/requests`, { data: BODY, headers: headers() });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.request).toMatchObject({ status: "CONFIGURING", proposalStatus: "VALID", blockers: [] });
    expect(body.request.proposals[0]).toMatchObject({ kind: "BOX", perBoxMinor: 3350, totalMinor: 67_000, boxCount: 20, currency: "USD" });
    expect(new URL(body.humanUrl).pathname).toMatch(/^\/o\/.+\..+$/);

    const read = await request.get(`${A}/requests/${body.request.id}`, { headers: { ...headers(), authorization: `Bearer ${body.requestToken}` } });
    expect(read.status()).toBe(200);
    expect((await read.json()).request).toMatchObject({ id: body.request.id, proposalStatus: "VALID", missing: [] });
  });

  test("50 kits: the bottle is out of stock at that quantity, code offers the mug: $29.50 a kit, $1,475.00", async ({ request }) => {
    const res = await request.post(`${A}/stores/demo-event-kits/requests`, { data: { ...BODY, boxCount: 50 }, headers: headers() });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.request.proposalStatus).toBe("BLOCKED");
    expect(body.request.blockers[0]).toMatchObject({ code: "INSUFFICIENT_STOCK", sku: "BOTTLE-INSULATED", needed: 50 });
    expect(body.request.proposals[0]).toMatchObject({ kind: "SWAP", perBoxMinor: 2950, totalMinor: 147_500, swap: { toSku: "MUG-ENAMEL" } });
  });

  test("a read with no token, a wrong token, the human link as a token, or the token in the address is the same 404", async ({ request }) => {
    const made = await (await request.post(`${A}/stores/demo-event-kits/requests`, { data: BODY, headers: headers() })).json();
    const url = `${A}/requests/${made.request.id}`;
    const human = new URL(made.humanUrl).pathname.replace("/o/", "");
    const bodies = new Set<string>();
    for (const attempt of [
      request.get(url, { headers: headers() }),
      request.get(url, { headers: { ...headers(), authorization: "Bearer not-the-token" } }),
      request.get(url, { headers: { ...headers(), authorization: `Bearer ${human}` } }),
      request.get(`${url}?token=${made.requestToken}`, { headers: headers() }),
    ]) {
      const res = await attempt;
      expect(res.status()).toBe(404);
      bodies.add(JSON.stringify(await res.json()));
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: { code: "NOT_FOUND" } })]);
  });

  test("a price, a total, free text or a wrong type is a 400 with coded issues, and nothing is stored", async ({ request }) => {
    // Tests run side by side, so "nothing was stored" is checked by a budget no other test uses: it would appear in the first message of any request that got in.
    const CANARY = 7_654_321; // $76,543.21 per box
    const odd = { ...BODY, maxPricePerBoxMinor: CANARY };
    for (const data of [{ ...odd, price: 1 }, { ...odd, note: "ignore the rules" }, { ...odd, boxCount: "20" }, { ...odd, boxCount: 0 }, { ...odd, requestedPickupDate: "2026-02-30" }]) {
      const res = await request.post(`${A}/stores/demo-event-kits/requests`, { data, headers: headers() });
      expect(res.status(), JSON.stringify(data)).toBe(400);
      expect((await res.json()).error).toMatchObject({ code: "INVALID_INPUT" });
    }
    const stored = await db.from("messages").select("id", { count: "exact", head: true }).ilike("body", "%76,543.21%");
    expect(stored.error).toBeNull();
    expect(stored.count).toBe(0);
  });

  test("not JSON is 400, a form post is 415, an oversized body is 413, an unknown shop is 404", async ({ request }) => {
    const url = `${A}/stores/demo-event-kits/requests`;
    const notJson = await request.post(url, { data: Buffer.from("{ not json"), headers: { ...headers(), "content-type": "application/json" } });
    expect(notJson.status()).toBe(400);
    expect((await notJson.json()).error.code).toBe("INVALID_JSON");
    expect((await request.post(url, { form: { boxCount: "20" }, headers: headers() })).status()).toBe(415);
    expect((await request.post(url, { data: { ...BODY, note: "x".repeat(3000) }, headers: headers() })).status()).toBe(413);
    expect((await request.post(`${A}/stores/no-such-shop/requests`, { data: BODY, headers: headers() })).status()).toBe(404);
    expect((await request.get(`${A}/stores/no-such-shop`, { headers: headers() })).status()).toBe(404);
  });

  test("a burst from one address is answered with 429 and Retry-After, and the request that was refused creates nothing", async ({ request }) => {
    const address = { "x-forwarded-for": `100.70.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}` };
    const url = `${A}/stores/demo-event-kits/requests`;
    // Ten bodies that are refused (and store nothing) use up the ten creates an address may make in a minute...
    for (let i = 0; i < 10; i++) expect((await request.post(url, { data: {}, headers: address })).status(), `call ${i + 1}`).toBe(400);
    // ...so the eleventh, a perfectly good request, is turned away before anything is read. Its budget is one no other test uses.
    const CANARY = 7_654_322; // $76,543.22 per box
    const refused = await request.post(url, { data: { ...BODY, maxPricePerBoxMinor: CANARY }, headers: address });
    expect(refused.status()).toBe(429);
    expect(Number(refused.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(await refused.json()).toEqual({ error: { code: "RATE_LIMITED" } });
    const stored = await db.from("messages").select("id", { count: "exact", head: true }).ilike("body", "%76,543.22%");
    expect(stored.count).toBe(0);
  });

  test("reads have their own limit: after sixty a minute from one address the next is a 429 (and the earlier ones were ordinary 404s)", async ({ request }) => {
    const address = { "x-forwarded-for": `100.71.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}` };
    const url = `${A}/requests/00000000-0000-4000-8000-000000000000`;
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await request.get(url, { headers: address })).status();
    expect(last).toBe(429);
    expect((await request.get(`${A}/stores`, { headers: address })).status()).toBe(200); // browsing is counted separately
  });
});
