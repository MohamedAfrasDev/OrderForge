import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { buildWorksheet, type FulfillmentResult, type JobStatus } from "@/domain/fulfillment";
import { verifyApprovalBinding } from "@/services/quote/verify-binding";
import { auditJob, callRpc, type ServiceContext } from "./shared";

export const DEFAULT_LEAD_DAYS = 7;
const leadRule = z.strictObject({ days: z.number().int().min(0).max(365) });
const methodRule = z.strictObject({ method: z.string().min(1).max(40) });

export type CreatedJob = { jobId: string; status: JobStatus; already: boolean };

async function ruleValue(db: SupabaseClient, merchantId: string, key: string): Promise<unknown | null> {
  const { data, error } = await db.from("business_rules").select("value").eq("merchant_id", merchantId).eq("key", key).maybeSingle();
  if (error) throw new Error(`load rule ${key}: ${error.message}`);
  return data ? data.value : null;
}

/**
 * Makes the one job of a paid purchase. The accepted quote must still verify (`verifyApprovalBinding`), and the worksheet is
 * built from that snapshot only, never from the live catalog. Whether the purchase is paid is decided by the database in
 * the same step, so a caller that is wrong about it gets NOT_PAID and nothing is created. Safe to call again and in
 * parallel: the same job comes back (`already`).
 */
export async function createJobForPurchase(db: SupabaseClient, purchaseId: string, ctx: ServiceContext): Promise<FulfillmentResult<CreatedJob>> {
  const purchase = await db.from("purchases").select("id, merchant_id, approval_id").eq("id", purchaseId).maybeSingle();
  if (purchase.error) throw new Error(`load purchase: ${purchase.error.message}`);
  if (!purchase.data) return { ok: false, code: "NOT_FOUND" };
  const merchantId = purchase.data.merchant_id as string;

  // A job that exists is returned as it is; the rest of the checks are for making one.
  const existing = await db.from("preparation_jobs").select("id, status").eq("purchase_id", purchaseId).maybeSingle();
  if (existing.error) throw new Error(`load job: ${existing.error.message}`);
  if (existing.data) return { ok: true, value: { jobId: existing.data.id as string, status: existing.data.status as JobStatus, already: true } };

  const binding = await verifyApprovalBinding(db, purchase.data.approval_id as string);
  if (!binding.ok) return { ok: false, code: "QUOTE_NOT_ACCEPTED", cause: binding.code };

  const lead = await ruleValue(db, merchantId, "production_lead_days");
  const leadParsed = lead === null ? { success: true as const, data: { days: DEFAULT_LEAD_DAYS } } : leadRule.safeParse(lead);
  if (!leadParsed.success) return { ok: false, code: "INVALID_INPUT", cause: "the production_lead_days rule is malformed" };

  const method = await ruleValue(db, merchantId, "fulfilment");
  const methodParsed = method === null ? { success: true as const, data: { method: "customer_pickup" } } : methodRule.safeParse(method);
  if (!methodParsed.success || methodParsed.data.method !== "customer_pickup") {
    return { ok: false, code: "INVALID_INPUT", cause: "only customer pickup is supported" };
  }

  const decision = await db.from("merchant_decisions").select("confirmed_conditions").eq("purchase_id", purchaseId).maybeSingle();
  if (decision.error) throw new Error(`load decision: ${decision.error.message}`);
  const confirmedRaw = decision.data?.confirmed_conditions;
  const confirmed = Array.isArray(confirmedRaw) ? confirmedRaw.filter((c): c is string => typeof c === "string") : [];

  const worksheet = buildWorksheet(binding.value.snapshot, {
    purchaseId,
    quoteHash: binding.value.quoteHash,
    fulfilmentMethod: "customer_pickup",
    productionLeadDays: leadParsed.data.days,
    createdAt: ctx.now,
    confirmedConditions: confirmed,
  });

  const out = await callRpc(db, "fulfillment_create_job", { p_purchase_id: purchaseId, p_worksheet: worksheet, p_now: ctx.now });
  if (!out.ok) return { ok: false, code: out.code ?? "INVALID_INPUT" };

  const created: CreatedJob = { jobId: out.job_id!, status: out.status as JobStatus, already: out.already === true };
  if (!created.already) {
    await auditJob(db, ctx, "system", "fulfillment.job_created", "preparation_job", created.jobId, {
      job_id: created.jobId,
      purchase_id: purchaseId,
      to: "QUEUED",
    });
  }
  return { ok: true, value: created };
}

export type MissingJobsSummary = { checked: number; created: number };

/**
 * The safety net behind the accept action: creates the job of every paid purchase that has none (a capture settled out of
 * doubt, a webhook, a failed call). A bounded batch, oldest payment first. A purchase that fails does not stop the rest; it
 * is audited, and after everything else has been done the run throws, so the scheduler shows it as failed until someone
 * looks. `purchaseIds` narrows a run to certain purchases (used by tests, also usable for a targeted run).
 */
export async function createMissingJobs(
  db: SupabaseClient,
  ctx: ServiceContext,
  options: { limit?: number; purchaseIds?: readonly string[] } = {},
): Promise<MissingJobsSummary> {
  const limit = options.limit ?? 20;
  const listed = await db.rpc("fulfillment_paid_purchases_without_job", { p_limit: options.purchaseIds ? 200 : limit });
  if (listed.error) throw new Error(`list paid purchases without a job: ${listed.error.message}`);
  const only = options.purchaseIds ? new Set(options.purchaseIds) : null;
  const batch = ((listed.data ?? []) as Array<{ purchase_id: string }>).map((r) => r.purchase_id).filter((id) => !only || only.has(id)).slice(0, limit);

  const summary = { checked: 0, created: 0 };
  let failed = 0;
  for (const purchaseId of batch) {
    summary.checked += 1;
    try {
      const result = await createJobForPurchase(db, purchaseId, { ...ctx, actor: ctx.actor ?? "system:cron" });
      if (!result.ok) throw new Error(result.code);
      if (!result.value.already) summary.created += 1;
    } catch (error) {
      failed += 1;
      try {
        await auditJob(db, ctx, "system:cron", "fulfillment.job_error", "purchase", purchaseId, {
          purchase_id: purchaseId,
          reason: error instanceof Error ? error.message.slice(0, 150) : "error",
        });
      } catch {
        // The audit itself failing must not hide the other purchases.
      }
    }
  }
  if (failed > 0) throw new Error(`createMissingJobs: ${failed} of ${summary.checked} purchases failed`);
  return summary;
}
