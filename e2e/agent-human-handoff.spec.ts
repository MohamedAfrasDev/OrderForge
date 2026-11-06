// An agent asks for a box through the API; a person finishes the order. The agent's own token opens nothing in the order room, and nothing the
// agent holds can pay. Stand-in for PayPal is the local fake (mocked); no model is involved (code chooses and prices the box).
// Two kits only, so the stock the second-shop journey needs is never at risk when the two specs run side by side.
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { adminClient, needsLocalSupabase } from "./payments-support";
import { ensureKitShop } from "./second-shop-support";

const A = "/api/agent/v1";

test.describe("an agent's request, finished by a person (local Supabase, fake PayPal: mocked)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");
  test.setTimeout(90_000);

  let db: SupabaseClient;
  test.beforeAll(async () => {
    db = adminClient();
    await ensureKitShop(db);
    // The daily cap is counted from the audit trail, which a local database keeps across runs: clear this shop's count (LOCAL database only).
    await db.from("audit_events").delete().eq("action", "intake.agent_request_created").eq("data->>store", "demo-event-kits");
  });

  test("the agent gets a priced box and a link; the person chooses it, accepts the exact price and is sent to PayPal; the agent can read the request throughout", async ({ page, request }) => {
    const address = { "x-forwarded-for": `100.68.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}` };
    await page.context().setExtraHTTPHeaders(address);

    // 1. The agent: five fields in, a priced box and a link for a person out.
    const made = await request.post(`${A}/stores/demo-event-kits/requests`, { data: { boxCount: 2, noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000 }, headers: address });
    expect(made.status()).toBe(201);
    const body = await made.json();
    expect(body.request.proposals[0]).toMatchObject({ kind: "BOX", perBoxMinor: 3350, totalMinor: 6700, boxCount: 2 });
    const humanPath = new URL(body.humanUrl).pathname;

    // 2. The person opens the link and sees the same box and the same price, in words.
    await page.goto(humanPath);
    await expect(page.getByRole("heading", { level: 1, name: "Your request" })).toBeVisible();
    const proposals = page.getByRole("region", { name: "Proposals" });
    await expect(proposals).toContainText("$33.50 per box · $67.00 for 2 boxes");
    await expect(page.getByTestId("order-header").getByRole("heading", { level: 2, name: "Choose your box", exact: true })).toBeVisible();

    // 3. They choose the box and accept the exact price: only they can.
    await proposals.getByRole("button", { name: "Choose this box" }).click();
    const price = page.getByRole("region", { name: "Your price" });
    await expect(price).toContainText("$67.00");
    await price.getByRole("button", { name: "Accept this price" }).click();
    await expect(price.getByRole("status")).toContainText("You accepted this exact price");

    // 4. PayPal sets the money aside: the person is sent to PayPal's own page (not loaded here; the redirect is checked).
    const payment = page.getByRole("region", { name: "Payment" });
    await expect(payment).toContainText("You won't be charged yet.");
    await page.route("https://www.sandbox.paypal.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>PayPal sandbox page</p>" }));
    await payment.getByRole("button", { name: "Approve on PayPal" }).click();
    await expect(page).toHaveURL(/https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=FAKEORDER\d+/);
    const purchase = await db.from("purchases").select("id").eq("inquiry_id", body.request.id).single();
    const attempt = await db.from("payment_attempts").select("amount_minor").eq("purchase_id", purchase.data!.id as string).single();
    expect(attempt.data!.amount_minor).toBe(6700); // the exact price the agent was shown, in cents

    // 5. The agent can still read its request with its own token.
    const read = await request.get(`${A}/requests/${body.request.id}`, { headers: { ...address, authorization: `Bearer ${body.requestToken}` } });
    expect(read.status()).toBe(200);
    expect((await read.json()).request.id).toBe(body.request.id);
  });

  test("the agent's token opens nothing in the order room, and the person's link is not a token for the API", async ({ page, request }) => {
    const address = { "x-forwarded-for": `100.69.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}` };
    await page.context().setExtraHTTPHeaders(address);
    const body = await (await request.post(`${A}/stores/demo-event-kits/requests`, { data: { boxCount: 1, noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000 }, headers: address })).json();

    const asLink = await page.goto(`/o/${body.requestToken}`);
    expect(asLink!.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "We couldn't find that" })).toBeVisible();

    const human = new URL(body.humanUrl).pathname.replace("/o/", "");
    const asToken = await request.get(`${A}/requests/${body.request.id}`, { headers: { ...address, authorization: `Bearer ${human}` } });
    expect(asToken.status()).toBe(404);
  });
});
