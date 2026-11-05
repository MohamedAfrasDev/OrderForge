import type { SupabaseClient } from "@supabase/supabase-js";
import { eventsToQueue, type RequestState } from "@/domain/notifications";

export type EnqueueContext = { now: string };

/** Requests older than this are not looked at: their link has expired and nobody is waiting on them. */
const WINDOW_DAYS = 14;
const MAX_INQUIRIES = 500;
const CHUNK = 40;

type Rel<T> = T | T[] | null;
const many = <T,>(value: Rel<T>): T[] => (value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]);

type PurchaseRow = {
  id: string;
  inquiry_id: string;
  payment_attempts: Rel<{ state: string; created_at: string }>;
  merchant_decisions: Rel<{ decision: string }>;
  preparation_jobs: Rel<{ id: string; status: string }>;
};

/**
 * Looks at the state of recent requests and queues the emails that state calls for. It only reads order data and only writes `notifications`
 * rows, so it can never change an order. A row's key is unique: running this again, or twice at once, queues nothing that is already queued.
 * Returns how many rows this run added.
 */
export async function enqueueNotifications(db: SupabaseClient, ctx: EnqueueContext): Promise<{ queued: number }> {
  const since = new Date(Date.parse(ctx.now) - WINDOW_DAYS * 86_400_000).toISOString();
  const inquiries = await db.from("inquiries").select("id, status, customer_email").gte("created_at", since).order("created_at", { ascending: false }).limit(MAX_INQUIRIES);
  if (inquiries.error) throw new Error(`enqueue: load requests: ${inquiries.error.message}`);
  const rows = (inquiries.data ?? []) as Array<{ id: string; status: string; customer_email: string | null }>;
  if (rows.length === 0) return { queued: 0 };
  const ids = rows.map((r) => r.id);

  // Ids travel in the URL, so ask in small groups rather than all at once.
  const quotes: Array<{ id: string; inquiry_id: string }> = [];
  const messages: Array<{ id: string; inquiry_id: string }> = [];
  const purchases: PurchaseRow[] = [];
  for (let at = 0; at < ids.length; at += CHUNK) {
    const part = ids.slice(at, at + CHUNK);
    const [q, m, p] = await Promise.all([
      db.from("quote_versions").select("id, inquiry_id").in("inquiry_id", part).not("published_at", "is", null),
      db.from("messages").select("id, inquiry_id").in("inquiry_id", part).eq("role", "merchant"),
      db.from("purchases").select("id, inquiry_id, payment_attempts(state, created_at), merchant_decisions(decision), preparation_jobs:preparation_jobs(id, status)").in("inquiry_id", part),
    ]);
    if (q.error) throw new Error(`enqueue: load prices: ${q.error.message}`);
    if (m.error) throw new Error(`enqueue: load replies: ${m.error.message}`);
    if (p.error) throw new Error(`enqueue: load orders: ${p.error.message}`);
    quotes.push(...((q.data ?? []) as Array<{ id: string; inquiry_id: string }>));
    messages.push(...((m.data ?? []) as Array<{ id: string; inquiry_id: string }>));
    purchases.push(...((p.data ?? []) as unknown as PurchaseRow[]));
  }

  const quotesBy = group(quotes);
  const messagesBy = group(messages);
  const purchasesBy = group(purchases);

  const events = rows.flatMap((inquiry) => {
    const state: RequestState = {
      inquiryId: inquiry.id,
      hasCustomerEmail: inquiry.customer_email !== null,
      withShop: inquiry.status === "REVIEW_REQUIRED",
      publishedQuoteIds: (quotesBy.get(inquiry.id) ?? []).map((q) => q.id),
      shopMessageIds: (messagesBy.get(inquiry.id) ?? []).map((m) => m.id),
      purchases: (purchasesBy.get(inquiry.id) ?? []).map((p) => {
        const latest = many(p.payment_attempts).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
        const decision = many(p.merchant_decisions)[0]?.decision;
        const job = many(p.preparation_jobs)[0];
        return {
          purchaseId: p.id,
          awaitingShop: latest?.state === "AUTHORIZED" && decision !== "accepted" && decision !== "declined",
          // Accepted means the money was taken: the shop said yes and the capture settled.
          decision: decision === "declined" ? "declined" : decision === "accepted" && latest?.state === "CAPTURED" ? "accepted" : null,
          jobId: job?.id ?? null,
          jobReady: job?.status === "READY_FOR_PICKUP" || job?.status === "COLLECTED",
        };
      }),
    };
    return eventsToQueue(state).map((e) => ({ inquiry_id: inquiry.id, recipient: e.recipient, kind: e.kind, dedupe_key: e.dedupeKey }));
  });
  if (events.length === 0) return { queued: 0 };

  let queued = 0;
  for (let at = 0; at < events.length; at += 200) {
    const inserted = await db.from("notifications").upsert(events.slice(at, at + 200), { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id");
    if (inserted.error) throw new Error(`enqueue: write: ${inserted.error.message}`);
    queued += (inserted.data ?? []).length;
  }
  return { queued };
}

function group<T extends { inquiry_id: string }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(item.inquiry_id, [...(out.get(item.inquiry_id) ?? []), item]);
  return out;
}
