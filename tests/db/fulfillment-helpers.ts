import type { SupabaseClient } from "@supabase/supabase-js";
import { buildWorksheet, type Worksheet } from "@/domain/fulfillment";
import type { QuoteSnapshot } from "@/domain/quote";
import { cents } from "@/lib/money";
import { unique } from "./helpers";
import { T0, pay, type PayOut } from "./payments-helpers";
import { decide, payFixture, settle, unknownFixture, type Fixture } from "./payments-fixtures";

export { T0 };

/** A snapshot shaped like an accepted quote (the fixtures' own quote has no lines; the worksheet is built from this). */
export const snapshotFor = (f: Pick<Fixture, "merchantId" | "inquiryId">): QuoteSnapshot =>
  ({
    schema: "orderforge.quote.v1",
    merchantId: f.merchantId,
    inquiryId: f.inquiryId,
    version: 1,
    requirementVersionId: null,
    boxCount: 4,
    perBoxMinor: cents(27000),
    totalMinor: cents(108000),
    currency: "USD",
    lines: [{ slotId: "gift", sku: "PF-GIFT", name: "Fixture gift", unitPriceMinor: cents(27000), quantity: 1 }],
    conditions: [],
  }) as unknown as QuoteSnapshot;

export const worksheetFor = (f: Pick<Fixture, "merchantId" | "inquiryId" | "purchaseId" | "quoteHash">, over: Partial<Worksheet> = {}): Worksheet => ({
  ...buildWorksheet(snapshotFor(f), {
    purchaseId: f.purchaseId,
    quoteHash: f.quoteHash,
    fulfilmentMethod: "customer_pickup",
    productionLeadDays: 7,
    createdAt: T0,
    confirmedConditions: [],
  }),
  ...over,
});

/** A purchase whose payment is a verified capture: attempt CAPTURED, reservation COMMITTED. */
export async function paidFixture(db: SupabaseClient): Promise<Fixture> {
  const f = await payFixture(db, "AUTHORIZED");
  const decided = await decide(db, f, "accepted");
  if (!decided.ok) throw new Error(`decide: ${decided.code}`);
  const captured = await settle(db, f.attemptId, "CAPTURED", { p_capture_id: unique("CAP") });
  if (!captured.ok) throw new Error(`capture: ${captured.code}`);
  return f;
}

export const createJob = (db: SupabaseClient, purchaseId: string, worksheet: unknown, now = T0): Promise<PayOut> =>
  pay(db, "fulfillment_create_job", { p_purchase_id: purchaseId, p_worksheet: worksheet, p_now: now });

export { decide, payFixture, settle, unknownFixture };
export type { Fixture };

export async function jobOf(db: SupabaseClient, purchaseId: string) {
  const found = await db.from("preparation_jobs").select("id, status, worksheet, created_at").eq("purchase_id", purchaseId).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  return found.data as { id: string; status: string; worksheet: Worksheet; created_at: string } | null;
}

export async function eventsOf(db: SupabaseClient, jobId: string) {
  const found = await db.from("preparation_events").select("status, from_status, actor, note, created_at").eq("job_id", jobId).order("created_at");
  if (found.error) throw new Error(found.error.message);
  return found.data as Array<{ status: string; from_status: string | null; actor: string | null; note: string | null; created_at: string }>;
}
