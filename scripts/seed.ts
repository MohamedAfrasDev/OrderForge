import { adminClient, parseOnly, purchaseCount, runSeed } from "./lib.ts";

// `npm run seed` seeds every demo shop. `npm run seed -- --only=<shop slug>` creates or completes just that shop and its owner and leaves the
// others untouched (for example `--only=demo-event-kits` to add the second shop to a site that already runs the first). A bad value stops here.
const only = parseOnly(process.argv);
const db = adminClient();

// The seed puts stock back to the fixture levels. With orders in the database that corrupts the books: reserved units
// are zeroed under live holds and committed units come back (this happened on the hosted project, see
// doc/evidence/payments-real-sandbox.md). Refuse unless the caller says it is really intended. With --only, only the orders of
// the shop being seeded count: another shop's orders are not touched by this run.
const orders = await purchaseCount(db, only);
if (orders > 0 && !process.argv.includes("--reset-stock-despite-orders")) {
  throw new Error(
    `Refusing to seed: ${orders} purchase(s) exist${only ? ` for ${only}` : ""} and seeding resets stock to the fixture levels, which breaks reserved and committed stock. ` +
      "Use `npm run demo:reset` to start clean, or pass --reset-stock-despite-orders if you really mean it.",
  );
}

await runSeed(db, process.env, { only });
