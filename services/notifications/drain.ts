import type { SupabaseClient } from "@supabase/supabase-js";
import { render, type NotificationKind, type RenderData } from "@/domain/notifications";
import { createCustomerLink } from "@/lib/access/customer-link";
import type { EmailPort } from "@/lib/email/port";
import { cents, format } from "@/lib/money";

export type DrainDeps = {
  /** The provider, or null when none is configured: nothing is sent and the rows are marked SKIPPED. */
  port: EmailPort | null;
  accessSecret: string;
  /** The app's own address, without a trailing slash, for the links in emails. */
  appBaseUrl: string;
  replyTo?: string;
  /** How long one send may take before it counts as a failure. Defaults to 10 seconds. */
  timeoutMs?: number;
};
export type DrainContext = { now: string };
export type DrainSummary = { sent: number; failed: number; skipped: number; retrying: number };

/** The most emails one request ever gets, so a loop or a flood of events can never become a flood of mail. */
export const MAX_PER_REQUEST = 8;
export const MAX_ATTEMPTS = 3;
const BATCH = 50;
const SEND_TIMEOUT_MS = 10_000;
const LINK_DAYS = 14;

type Row = { id: string; inquiry_id: string; recipient: "customer" | "shop"; kind: NotificationKind; dedupe_key: string; attempts: number };

/**
 * Sends the queued emails through the port. Each row is claimed with a compare-and-set on its attempt count, so two runs at once never both
 * send it. A send that fails, times out or throws is retried by the next runs (up to three attempts) and then marked FAILED. Whatever the
 * provider does, nothing here touches an order: it reads what the email says and writes only `notifications`. Nothing is logged: not an
 * address, not a link, not a body.
 */
export async function drainNotifications(db: SupabaseClient, deps: DrainDeps, ctx: DrainContext): Promise<DrainSummary> {
  const summary: DrainSummary = { sent: 0, failed: 0, skipped: 0, retrying: 0 };
  const pending = await db.from("notifications").select("id, inquiry_id, recipient, kind, dedupe_key, attempts").eq("status", "PENDING").order("created_at", { ascending: true }).limit(BATCH);
  if (pending.error) throw new Error(`drain: load queue: ${pending.error.message}`);

  for (const row of (pending.data ?? []) as Row[]) {
    const claimed = await db.from("notifications").update({ attempts: row.attempts + 1 }).eq("id", row.id).eq("status", "PENDING").eq("attempts", row.attempts).select("id");
    if (claimed.error) throw new Error(`drain: claim: ${claimed.error.message}`);
    if ((claimed.data ?? []).length === 0) continue; // another run has it

    const outcome = await deliver(db, deps, ctx, row);
    if (outcome === "skip") {
      await finish(db, row.id, { status: "SKIPPED" });
      summary.skipped += 1;
    } else if (outcome === "sent") {
      await finish(db, row.id, { status: "SENT", sent_at: ctx.now });
      summary.sent += 1;
    } else if (row.attempts + 1 >= MAX_ATTEMPTS) {
      await finish(db, row.id, { status: "FAILED" });
      summary.failed += 1;
    } else {
      summary.retrying += 1; // stays PENDING for the next run
    }
  }
  return summary;
}

async function finish(db: SupabaseClient, id: string, fields: Record<string, unknown>): Promise<void> {
  const done = await db.from("notifications").update(fields).eq("id", id).eq("status", "PENDING");
  if (done.error) throw new Error(`drain: finish: ${done.error.message}`);
}

async function deliver(db: SupabaseClient, deps: DrainDeps, ctx: DrainContext, row: Row): Promise<"sent" | "skip" | "fail"> {
  if (!deps.port) return "skip";

  const sent = await db.from("notifications").select("id", { count: "exact", head: true }).eq("inquiry_id", row.inquiry_id).eq("status", "SENT");
  if (sent.error) throw new Error(`drain: count: ${sent.error.message}`);
  if ((sent.count ?? 0) >= MAX_PER_REQUEST) return "skip";

  const inquiry = await db.from("inquiries").select("merchant_id, access_version, customer_email").eq("id", row.inquiry_id).maybeSingle();
  if (inquiry.error) throw new Error(`drain: request: ${inquiry.error.message}`);
  if (!inquiry.data) return "skip";
  const merchant = await db.from("merchants").select("name, owner_user_id").eq("id", inquiry.data.merchant_id as string).maybeSingle();
  if (merchant.error) throw new Error(`drain: shop: ${merchant.error.message}`);
  if (!merchant.data) return "skip";

  const to = row.recipient === "customer" ? (inquiry.data.customer_email as string | null) : await shopAddress(db, merchant.data.owner_user_id as string | null);
  if (!to) return "skip";

  const link =
    row.recipient === "customer"
      ? `${deps.appBaseUrl}/o/${createCustomerLink({ inquiryId: row.inquiry_id, version: inquiry.data.access_version as number, expiresAt: new Date(Date.parse(ctx.now) + LINK_DAYS * 86_400_000), secret: deps.accessSecret })}`
      : `${deps.appBaseUrl}${row.kind === "order_awaiting_ok" ? "/merchant/decisions" : "/merchant/inquiries"}`;
  const data: RenderData = { shopName: merchant.data.name as string, link, ...(await amountsFor(db, row)) };
  const email = render(row.kind, data);

  try {
    const result = await withTimeout(deps.port.send({ to, subject: email.subject, text: email.text, html: email.html, idempotencyKey: row.id, ...(deps.replyTo ? { replyTo: deps.replyTo } : {}) }), deps.timeoutMs ?? SEND_TIMEOUT_MS);
    return result.ok ? "sent" : "fail";
  } catch {
    return "fail";
  }
}

/** The shop's address is whoever owns the shop's login, looked up now and never stored. */
async function shopAddress(db: SupabaseClient, ownerUserId: string | null): Promise<string | null> {
  if (!ownerUserId) return null;
  const user = await db.auth.admin.getUserById(ownerUserId);
  return user.error ? null : (user.data.user?.email ?? null);
}

/** The amount and box count an email may state, from the quote the event is about (named by the id at the end of its dedupe key). */
async function amountsFor(db: SupabaseClient, row: Row): Promise<Pick<RenderData, "totalText" | "boxCount">> {
  const id = row.dedupe_key.slice(row.dedupe_key.indexOf(":") + 1);
  let quoteId: string | null = null;
  if (row.kind === "price_ready") quoteId = id;
  else if (row.kind === "order_accepted" || row.kind === "order_awaiting_ok") {
    const purchase = await db.from("purchases").select("quote_version_id").eq("id", id).maybeSingle();
    if (purchase.error) throw new Error(`drain: order: ${purchase.error.message}`);
    quoteId = (purchase.data?.quote_version_id as string | undefined) ?? null;
  }
  if (!quoteId) return {};
  const quote = await db.from("quote_versions").select("total_minor, lines").eq("id", quoteId).maybeSingle();
  if (quote.error) throw new Error(`drain: price: ${quote.error.message}`);
  if (!quote.data) return {};
  const boxCount = (quote.data.lines as { boxCount?: unknown } | null)?.boxCount;
  return { totalText: format(cents(Number(quote.data.total_minor))), ...(typeof boxCount === "number" ? { boxCount } : {}) };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error)),
    );
  });
}
