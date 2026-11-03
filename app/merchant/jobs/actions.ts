"use server";

import { refresh } from "next/cache";
import { JOB_STATUSES, type JobStatus } from "@/domain/fulfillment";
import { requireMerchant } from "@/lib/access/require-merchant";
import { newCorrelationId } from "@/lib/correlation";
import { createAdminClient } from "@/lib/supabase/admin";
import { moveFailureMessage } from "@/services/fulfillment/customer-messages";
import { moveJob } from "@/services/fulfillment/move";

export type MoveState = { status: "idle" } | { status: "error"; message: string } | { status: "done"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

// Server actions are public endpoints: the merchant session is verified first, before any field is read. The database then
// refuses (as NOT_FOUND) any job of another merchant and any move the transition table does not allow. Only the job id, the
// status asked for and the note come from the browser.
export async function moveJobAction(_previous: MoveState, formData: FormData): Promise<MoveState> {
  const { user, merchant } = await requireMerchant();
  const jobId = field(formData, "jobId");
  const to = field(formData, "to");
  if (!UUID.test(jobId) || !(JOB_STATUSES as readonly string[]).includes(to)) return { status: "error", message: moveFailureMessage("INVALID_INPUT") };

  const result = await moveJob(
    createAdminClient(),
    { kind: "merchant", userId: user.id, merchantId: merchant.id },
    jobId,
    to as JobStatus,
    { note: field(formData, "note").trim() },
    { now: new Date().toISOString(), correlationId: newCorrelationId() },
  );
  refresh();
  return result.ok ? { status: "done", message: "Done." } : { status: "error", message: moveFailureMessage(result.code) };
}
