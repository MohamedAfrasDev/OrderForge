import { createHash, timingSafeEqual } from "node:crypto";
import { audit, type AuditInsert } from "@/lib/audit";
import { correlationIdFrom } from "@/lib/correlation";

export type ReconcileDeps = {
  cronSecret: string;
  insertAudit: AuditInsert;
};

const reply = (body: Record<string, string>, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time check of "Authorization: Bearer <secret>". An unset server secret authorizes nobody. */
function isAuthorized(header: string | null, secret: string): boolean {
  if (!secret) return false;
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) return false;
  // Hash both sides so the comparison is the same length whatever the caller sends.
  return timingSafeEqual(digest(match[1]), digest(secret));
}

/** The record a reconcile run leaves behind. Shared by the scheduled route and the manual button. */
export async function recordReconcileHeartbeat(
  insertAudit: AuditInsert,
  input: { actor: string; correlationId: string },
): Promise<void> {
  await audit(insertAudit, {
    actor: input.actor,
    action: "reconcile.heartbeat",
    entity: "system",
    entityId: "reconcile",
    correlationId: input.correlationId,
    data: { status: "ok" },
  });
}

/**
 * Entry point for the scheduled reconcile job (Supabase pg_cron -> pg_net -> this route).
 * Foundation only records a heartbeat; the payments module adds the real reconciliation here.
 * Safe to call repeatedly and concurrently: a run has no effect beyond one audit row.
 */
export async function handleReconcile(request: Request, deps: ReconcileDeps): Promise<Response> {
  if (!isAuthorized(request.headers.get("authorization"), deps.cronSecret)) {
    return reply({ error: "unauthorized" }, 401);
  }

  try {
    await recordReconcileHeartbeat(deps.insertAudit, {
      actor: "system:cron",
      correlationId: correlationIdFrom(request.headers),
    });
  } catch {
    // A non-2xx shows up in the scheduler's run history. Nothing about the cause is returned.
    return reply({ error: "heartbeat_failed" }, 500);
  }
  return reply({ status: "ok" }, 200);
}
