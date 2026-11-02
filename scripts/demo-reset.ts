import { adminClient, runSeed } from "./lib.ts";

// adminClient() throws unless SANDBOX_MODE=true, so this can never run against a live setup.
const db = adminClient();

const { error } = await db.rpc("demo_reset");
if (error) throw new Error(`demo_reset: ${error.message}`);
console.log("Application data cleared.");

await runSeed(db);
