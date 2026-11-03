import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import { readLocalSupabase } from "./tests/support/local-supabase";

const port = 3100;
// The local fake PayPal that e2e/global-setup.ts starts. The app under test talks to it, never to PayPal.
const FAKE_PAYPAL_PORT = 4011;

// E2E must never touch a hosted Supabase project (the real .env may point at one), so the dev
// server is started with the LOCAL stack's keys. Without a local stack it gets a dead URL and
// the sign-in tests skip themselves.
// Detected once, in the main process; workers inherit the result through the environment instead of
// asking the CLI again (several workers asking at once is slow and was a source of flakiness).
let local: { url: string; anonKey: string; serviceKey: string } | null = null;
if (process.env.E2E_LOCAL_SUPABASE === undefined) {
  const found = readLocalSupabase();
  if (found.ok) {
    local = found;
    process.env.E2E_LOCAL_SUPABASE = "1";
    process.env.E2E_SUPABASE_URL = found.url;
    process.env.E2E_SUPABASE_ANON_KEY = found.anonKey;
    process.env.E2E_SUPABASE_SERVICE_KEY = found.serviceKey;
  } else {
    process.env.E2E_LOCAL_SUPABASE = "0";
    console.warn(`\n[e2e] Local Supabase not available, so sign-in and database tests will be SKIPPED. ${found.reason}\n`);
  }
} else if (process.env.E2E_LOCAL_SUPABASE === "1") {
  local = {
    url: process.env.E2E_SUPABASE_URL!,
    anonKey: process.env.E2E_SUPABASE_ANON_KEY!,
    serviceKey: process.env.E2E_SUPABASE_SERVICE_KEY!,
  };
}
process.env.E2E_ACCESS_LINK_SECRET ??= randomBytes(32).toString("hex");
process.env.E2E_CRON_SECRET ??= randomBytes(32).toString("hex");
process.env.E2E_FAKE_PAYPAL_URL = `http://127.0.0.1:${FAKE_PAYPAL_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // A production build: it cannot clash with a `next dev` you already have running, and NEXT_PUBLIC_*
    // values are baked in at build time, so the env below is applied to the build as well.
    command: `npm run build && npm run start -- --port ${port}`,
    url: `http://localhost:${port}`,
    // Never reuse a running server: it may have been started with the real .env.
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: local?.url ?? "http://127.0.0.1:1",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: local?.anonKey ?? "e2e-placeholder-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: local?.serviceKey ?? "e2e-placeholder-service-role-key",
      ACCESS_LINK_SECRET: process.env.E2E_ACCESS_LINK_SECRET!,
      CRON_SECRET: process.env.E2E_CRON_SECRET!,
      PAYPAL_SPIKE_BASE_URL: `http://127.0.0.1:${FAKE_PAYPAL_PORT}`,
      // The intake screens run against a rule-based stand-in for the model, never a real one (refused unless the database is local).
      INTAKE_MODEL: "local-demo",
      // Dummy credentials: the test server must not carry the real ones from .env.
      PAYPAL_CLIENT_ID: "e2e-client-id",
      NEXT_PUBLIC_PAYPAL_CLIENT_ID: "e2e-client-id",
      PAYPAL_CLIENT_SECRET: "e2e-client-secret-0000000000",
    },
  },
});
