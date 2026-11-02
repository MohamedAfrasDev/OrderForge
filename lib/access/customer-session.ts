import "server-only";
import { connection } from "next/server";
import { getServerEnv } from "@/lib/env";
import { authorizeCustomerLink, type CustomerAccess } from "@/lib/access/inquiry-reads";
import { createAdminClient } from "@/lib/supabase/admin";

/** Server-side entry point for customer links: wires the real secret and the service-role client. */
export async function authorizeCustomerToken(token: string): Promise<CustomerAccess> {
  // Link expiry reads the clock, so this must run at request time, never during prerender.
  await connection();
  return authorizeCustomerLink(createAdminClient(), token, { secret: getServerEnv().ACCESS_LINK_SECRET });
}
