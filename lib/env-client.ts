import { parseClientEnv, type ClientEnv } from "@/lib/env-schema";

/**
 * Public environment, safe for the browser. Each NEXT_PUBLIC_ variable is read
 * with a literal property access so Next.js can inline it into the client bundle.
 */
export function getClientEnv(): ClientEnv {
  return parseClientEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_PAYPAL_CLIENT_ID: process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID,
  });
}
