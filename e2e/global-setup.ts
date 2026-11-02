import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createCustomerLink } from "../lib/access/customer-link";

// Creates throwaway accounts in the LOCAL Supabase stack for the sign-in tests.
// Skipped (and the tests skip too) when no local stack is running.
export default async function globalSetup() {
  if (process.env.E2E_LOCAL_SUPABASE !== "1") return;

  const url = process.env.E2E_SUPABASE_URL!;
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to create E2E accounts on non-local host ${host}`);
  }

  const db = createClient(url, process.env.E2E_SUPABASE_SERVICE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const tag = randomBytes(4).toString("hex");

  async function createUser(label: string) {
    const email = `e2e-${label}-${tag}@test.invalid`;
    const password = randomUUID();
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser(${label}): ${error?.message}`);
    return { id: data.user.id, email, password };
  }

  const merchantUser = await createUser("merchant");
  const outsider = await createUser("outsider");

  const merchantName = `E2E Merchant ${tag}`;
  const slug = `e2e-${tag}`;
  const merchant = await db
    .from("merchants")
    .insert({ slug, name: merchantName, owner_user_id: merchantUser.id })
    .select("id")
    .single();
  if (merchant.error) throw new Error(`merchant insert: ${merchant.error.message}`);

  // Two inquiries with distinctive messages and one signed customer link each.
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  async function createInquiry(label: string) {
    const text = `Secret request ${label} ${tag}`;
    const inquiry = await db.from("inquiries").insert({ merchant_id: merchant.data!.id }).select("id").single();
    if (inquiry.error) throw new Error(`inquiry ${label}: ${inquiry.error.message}`);
    const message = await db.from("messages").insert({ inquiry_id: inquiry.data.id, role: "customer", body: text });
    if (message.error) throw new Error(`message ${label}: ${message.error.message}`);
    const link = createCustomerLink({
      inquiryId: inquiry.data.id,
      version: 1,
      expiresAt,
      secret: process.env.E2E_ACCESS_LINK_SECRET!,
    });
    return { id: inquiry.data.id as string, text, link };
  }
  const a = await createInquiry("A");
  const b = await createInquiry("B");
  process.env.E2E_INQUIRY_A_ID = a.id;
  process.env.E2E_INQUIRY_A_LINK = a.link;
  process.env.E2E_INQUIRY_A_TEXT = a.text;
  process.env.E2E_INQUIRY_B_ID = b.id;
  process.env.E2E_INQUIRY_B_LINK = b.link;
  process.env.E2E_INQUIRY_B_TEXT = b.text;
  process.env.E2E_STORE_SLUG = slug;

  process.env.E2E_MERCHANT_EMAIL = merchantUser.email;
  process.env.E2E_MERCHANT_PASSWORD = merchantUser.password;
  process.env.E2E_MERCHANT_NAME = merchantName;
  process.env.E2E_OUTSIDER_EMAIL = outsider.email;
  process.env.E2E_OUTSIDER_PASSWORD = outsider.password;
}
