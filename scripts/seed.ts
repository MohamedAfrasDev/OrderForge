import { adminClient, runSeed } from "./lib.ts";

const db = adminClient();

// The seed puts stock back to the fixture levels. With orders in the database that corrupts the books: reserved units
// are zeroed under live holds and committed units come back (this happened on the hosted project, see
// doc/evidence/payments-real-sandbox.md). Refuse unless the caller says it is really intended.
const orders = await db.from("purchases").select("id", { count: "exact", head: true });
if (orders.error) throw new Error(`purchases: ${orders.error.message}`);
if ((orders.count ?? 0) > 0 && !process.argv.includes("--reset-stock-despite-orders")) {
  throw new Error(
    `Refusing to seed: ${orders.count} purchase(s) exist and seeding resets stock to the fixture levels, which breaks reserved and committed stock. ` +
      "Use `npm run demo:reset` to start clean, or pass --reset-stock-despite-orders if you really mean it.",
  );
}

await runSeed(db);
