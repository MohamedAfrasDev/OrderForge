import type { SupabaseClient } from "@supabase/supabase-js";
import { customerStatusOf, worksheetSchema, type CustomerStatus, type JobStatus, type Worksheet } from "@/domain/fulfillment";
import type { VerifiedInquiryId } from "@/lib/access/inquiry-reads";

type Embedded<T> = T | T[] | null;
const one = <T>(value: Embedded<T>): T | null => (Array.isArray(value) ? (value[0] ?? null) : value);

/**
 * What a customer may know about the job on their order: the plain status and the ready-by day. Nothing else: no worksheet,
 * no notes, no ids. Null until the job exists.
 */
export type CustomerJobView = { status: CustomerStatus; readyBy: string };

export async function jobStatusForCustomer(db: SupabaseClient, inquiryId: VerifiedInquiryId): Promise<CustomerJobView | null> {
  const quote = await db.from("quote_versions").select("id").eq("inquiry_id", inquiryId).eq("status", "ACCEPTED").maybeSingle();
  if (quote.error) throw new Error(`read accepted quote: ${quote.error.message}`);
  if (!quote.data) return null;

  const purchase = await db
    .from("purchases")
    .select("id, preparation_jobs(status, worksheet)")
    .eq("quote_version_id", quote.data.id as string)
    .eq("inquiry_id", inquiryId)
    .maybeSingle();
  if (purchase.error) throw new Error(`read purchase: ${purchase.error.message}`);
  if (!purchase.data) return null;

  const job = one((purchase.data as unknown as { preparation_jobs: Embedded<{ status: JobStatus; worksheet: { readyBy?: unknown } }> }).preparation_jobs);
  if (!job) return null;
  const readyBy = typeof job.worksheet?.readyBy === "string" ? job.worksheet.readyBy : null;
  if (readyBy === null) return null;
  return { status: customerStatusOf(job.status), readyBy };
}

export type JobEvent = { status: JobStatus; fromStatus: JobStatus | null; actor: string | null; note: string | null; at: string };

export type JobDetail = {
  jobId: string;
  purchaseId: string;
  inquiryId: string;
  status: JobStatus;
  readyBy: string;
  createdAt: string;
  updatedAt: string;
  worksheet: Worksheet;
  events: JobEvent[];
};

type JobQueryRow = {
  id: string;
  purchase_id: string;
  status: JobStatus;
  worksheet: unknown;
  created_at: string;
  updated_at: string;
  purchases: Embedded<{ merchant_id: string; inquiry_id: string }>;
  preparation_events: Array<{ status: JobStatus; from_status: JobStatus | null; actor: string | null; note: string | null; created_at: string }>;
};

const SELECT =
  "id, purchase_id, status, worksheet, created_at, updated_at, purchases!inner(merchant_id, inquiry_id), preparation_events(status, from_status, actor, note, created_at)";

function toDetail(r: JobQueryRow): JobDetail | null {
  const parsed = worksheetSchema.safeParse(r.worksheet);
  const purchase = one(r.purchases);
  if (!parsed.success || !purchase) return null;
  return {
    jobId: r.id,
    purchaseId: r.purchase_id,
    inquiryId: purchase.inquiry_id,
    status: r.status,
    readyBy: parsed.data.readyBy,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    worksheet: parsed.data as Worksheet,
    events: [...r.preparation_events]
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      .map((e) => ({ status: e.status, fromStatus: e.from_status, actor: e.actor, note: e.note, at: new Date(e.created_at).toISOString() })),
  };
}

/**
 * The merchant's jobs, newest first, each with its worksheet and event log. Read-only. Pass the merchant's own session client
 * so row level security applies: another merchant's jobs stay invisible even if their id were passed.
 */
export async function listJobsForMerchant(db: SupabaseClient, merchantId: string, limit = 100): Promise<JobDetail[]> {
  const found = await db.from("preparation_jobs").select(SELECT).eq("purchases.merchant_id", merchantId).order("created_at", { ascending: false }).limit(limit);
  if (found.error) throw new Error(`list jobs: ${found.error.message}`);
  return ((found.data ?? []) as unknown as JobQueryRow[]).map(toDetail).filter((d): d is JobDetail => d !== null);
}

/** One of the merchant's jobs in full, or null (also for another merchant's job). */
export async function readJob(db: SupabaseClient, merchantId: string, jobId: string): Promise<JobDetail | null> {
  const found = await db.from("preparation_jobs").select(SELECT).eq("id", jobId).eq("purchases.merchant_id", merchantId).maybeSingle();
  if (found.error) throw new Error(`read job: ${found.error.message}`);
  return found.data ? toDetail(found.data as unknown as JobQueryRow) : null;
}
