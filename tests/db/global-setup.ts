import { serviceClient } from "./helpers";

// Start every database test run from an empty application schema (auth users are kept).
// This clears the demo seed in the LOCAL database; run `npm run seed` afterwards if you need it.
export default async function setup() {
  const { error } = await serviceClient().rpc("demo_reset");
  if (error) throw new Error(`demo_reset failed: ${error.message}`);
}
