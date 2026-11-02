import { serviceClient } from "./helpers";

// Start every database test run from an empty application schema (auth users are kept).
// This clears the demo seed in the LOCAL database; run `npm run seed` afterwards if you need it.
export default async function setup() {
  try {
    const { error } = await serviceClient().rpc("demo_reset");
    if (error) throw new Error(`demo_reset failed: ${error.message}`);
  } catch (error) {
    // Vitest 5.0.5 can crash while printing an error thrown here, which hides the cause. Say it first.
    console.error(`\n[db tests] ${(error as Error).message}\n`);
    throw error;
  }
}
