// The whole product in a real browser, start to finish, against the LOCAL Supabase stack. Everything that would leave the machine is replaced:
// the assistant is the rule-based stand-in (mocked), PayPal is the local fake (mocked), and email goes through a recording fake (mocked). No real
// model, PayPal call or email is involved. Two runs: the order that builds itself and is collected, and the request the shop takes over.
import type { SupabaseClient } from "@supabase/supabase-js";
import { test } from "@playwright/test";
import { adminClient, needsLocalSupabase } from "./payments-support";
import { handedOverJourney, readyDemoShop, wholeJourney, type Shop } from "./journey-support";

test.describe("the whole journey (local Supabase, stand-in model, fake PayPal, fake email: mocked)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  let db: SupabaseClient;
  let shop: Shop;

  test.beforeAll(async () => {
    db = adminClient();
    shop = await readyDemoShop(db);
  });

  test("from the home page to collected: describe, one tap, choose, price, accept, PayPal, the shop accepts, prepares and hands over", async ({ page, browser }) => {
    await wholeJourney({ page, browser, db, shop });
  });

  test("a request the shop takes over: the shop builds the quote and the customer accepts it", async ({ page, browser }) => {
    await handedOverJourney({ page, browser, db, shop });
  });
});
