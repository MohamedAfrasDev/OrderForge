import type { SupabaseClient } from "@supabase/supabase-js";
import type { FulfillmentErrorCode } from "@/domain/fulfillment";
import { audit } from "@/lib/audit";
import { auditInsertFor, type ServiceContext } from "@/services/reservation/shared";

export type { ServiceContext };

export type RpcOut = {
  ok: boolean;
  code?: FulfillmentErrorCode;
  already?: boolean;
  job_id?: string;
  status?: string;
  from?: string;
};

export async function callRpc(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<RpcOut> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as RpcOut;
}

export async function auditJob(
  db: SupabaseClient,
  ctx: ServiceContext,
  defaultActor: string,
  action: string,
  entity: "preparation_job" | "purchase",
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await audit(auditInsertFor(db), {
    actor: ctx.actor ?? defaultActor,
    action,
    entity,
    entityId,
    correlationId: ctx.correlationId,
    data,
  });
}
