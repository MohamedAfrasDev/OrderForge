// The same two journeys on a 390 px wide phone: at every stage the page does not scroll sideways and its main action is on the screen without
// zooming. The shop's Today and Build a quote are checked at phone width too. Local, mocked (see journey.spec.ts).
import type { SupabaseClient } from "@supabase/supabase-js";
import { test } from "@playwright/test";
import { adminClient, needsLocalSupabase } from "./payments-support";
import { handedOverJourney, phoneCheck, readyDemoShop, wholeJourney, type Shop } from "./journey-support";

const PHONE = { width: 390, height: 800 };

test.describe("the whole journey at 390 px (local Supabase, mocked)", () => {
  test.skip(needsLocalSupabase, "needs a local Supabase stack: run `supabase start`");
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);
  test.use({ viewport: PHONE });

  let db: SupabaseClient;
  let shop: Shop;

  test.beforeAll(async () => {
    db = adminClient();
    shop = await readyDemoShop(db);
  });

  test("the order that builds itself, from the home page to collected", async ({ page, browser }) => {
    await wholeJourney({ page, browser, db, shop, check: phoneCheck, viewport: PHONE });
  });

  test("the request the shop takes over, including Today and Build a quote", async ({ page, browser }) => {
    await handedOverJourney({ page, browser, db, shop, check: phoneCheck, viewport: PHONE });
  });
});
