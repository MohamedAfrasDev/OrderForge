import { serviceClient } from "./helpers";

async function clearApplicationData(): Promise<void> {
  const { error } = await serviceClient().rpc("demo_reset");
  if (error) throw new Error(`demo_reset failed: ${error.message}`);
}

// Start every database test run from an empty application schema (auth users are kept), and leave it empty again.
// Tests insert fixtures straight into tables, some of which are not consistent on purpose (a reservation without
// reserved stock, for example). The scheduled reservation sweep treats those as accounting errors, so they must not
// outlive the run: anything that talks to the same local database afterwards, such as the E2E suite, starts clean.
// This clears the demo seed in the LOCAL database; run `npm run seed` afterwards if you need it.
export default async function setup() {
  try {
    await clearApplicationData();
  } catch (error) {
    // Vitest 5.0.5 can crash while printing an error thrown here, which hides the cause. Say it first.
    console.error(`\n[db tests] ${(error as Error).message}\n`);
    throw error;
  }
  return async () => {
    try {
      await clearApplicationData();
    } catch (error) {
      console.error(`\n[db tests] cleanup after the run failed: ${(error as Error).message}\n`);
    }
  };
}
