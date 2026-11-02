import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

const port = 3100;

// E2E must never touch a hosted Supabase project (the real .env may point at one), so the dev
// server is started with the LOCAL stack's keys. Without a local stack it gets a dead URL and
// the sign-in tests skip themselves.
function localSupabase(): { url: string; anonKey: string; serviceKey: string } | null {
  try {
    const raw = execSync("supabase status -o json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
    const json = JSON.parse(raw.slice(raw.indexOf("{")));
    return { url: json.API_URL, anonKey: json.ANON_KEY, serviceKey: json.SERVICE_ROLE_KEY };
  } catch {
    return null;
  }
}

const local = localSupabase();
process.env.E2E_LOCAL_SUPABASE = local ? "1" : "0";
// Workers re-load this file; ??= keeps the value the main process generated.
process.env.E2E_ACCESS_LINK_SECRET ??= randomBytes(32).toString("hex");
if (local) {
  process.env.E2E_SUPABASE_URL = local.url;
  process.env.E2E_SUPABASE_SERVICE_KEY = local.serviceKey;
}

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
    },
  },
});
