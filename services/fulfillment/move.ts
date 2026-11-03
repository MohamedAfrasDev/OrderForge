import type { SupabaseClient } from "@supabase/supabase-js";
import type { FulfillmentResult, JobStatus } from "@/domain/fulfillment";
import type { MerchantActor } from "@/services/quote/shared";
import { auditJob, callRpc, type ServiceContext } from "./shared";

export type MovedJob = { jobId: string; status: JobStatus; already: boolean };

/**
 * The merchant moves a job one step (start, finish, record the pickup, hold with a note, resume). The database checks that
 * the job belongs to the merchant (anything else is NOT_FOUND), applies the transition table and writes the event; asking
 * for the status the job is already in changes nothing, so a double click moves it once.
 */
export async function moveJob(
  db: SupabaseClient,
  actor: MerchantActor,
  jobId: string,
  to: JobStatus,
  input: { note?: string },
  ctx: ServiceContext,
): Promise<FulfillmentResult<MovedJob>> {
  const actorName = `merchant:${actor.userId}`;
  const out = await callRpc(db, "fulfillment_move_job", {
    p_job_id: jobId,
    p_merchant_id: actor.merchantId,
    p_to: to,
    p_note: input.note ?? null,
    p_actor: actorName,
    p_now: ctx.now,
  });
  if (!out.ok) return { ok: false, code: out.code ?? "INVALID_INPUT" };

  const moved: MovedJob = { jobId: out.job_id!, status: out.status as JobStatus, already: out.already === true };
  if (!moved.already) {
    await auditJob(db, ctx, actorName, "fulfillment.job_moved", "preparation_job", jobId, { job_id: jobId, from: out.from, to: moved.status });
  }
  return { ok: true, value: moved };
}
