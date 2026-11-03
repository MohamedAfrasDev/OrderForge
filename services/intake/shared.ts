import type { SupabaseClient } from "@supabase/supabase-js";
import { inquiryTransition, storedRequirementsSchema, type InquiryEvent, type InquiryStatus, type IntakeErrorCode, type StoredRequirements } from "@/domain/intake";
import { audit } from "@/lib/audit";
import { auditInsertFor, type ServiceContext } from "@/services/reservation/shared";

export type { ServiceContext };

/** The caps from the spec (assumption 9). Past one, the inquiry goes to the merchant rather than stopping silently. */
export const LIMITS = { messageChars: 4000, messages: 40, clarificationTurns: 3, modelRuns: 20 } as const;

export type MessageCheck = { ok: true; text: string } | { ok: false; code: Extract<IntakeErrorCode, "INVALID_INPUT" | "MESSAGE_TOO_LONG"> };

/** What the customer typed, trimmed at the ends and otherwise kept exactly (markup and instructions are just text). */
export function checkMessageBody(body: unknown): MessageCheck {
  if (typeof body !== "string") return { ok: false, code: "INVALID_INPUT" };
  const text = body.trim();
  if (text.length === 0 || text.includes("\u0000")) return { ok: false, code: "INVALID_INPUT" };
  if (text.length > LIMITS.messageChars) return { ok: false, code: "MESSAGE_TOO_LONG" };
  return { ok: true, text };
}

export type InquiryRow = { id: string; merchantId: string; status: InquiryStatus };

export async function loadInquiry(db: SupabaseClient, inquiryId: string): Promise<InquiryRow | null> {
  const found = await db.from("inquiries").select("id, merchant_id, status").eq("id", inquiryId).maybeSingle();
  if (found.error) throw new Error(`load inquiry: ${found.error.message}`);
  return found.data ? { id: found.data.id as string, merchantId: found.data.merchant_id as string, status: found.data.status as InquiryStatus } : null;
}

export async function auditIntake(db: SupabaseClient, ctx: ServiceContext, defaultActor: string, action: string, inquiryId: string, data: Record<string, unknown> = {}): Promise<void> {
  await audit(auditInsertFor(db), {
    actor: ctx.actor ?? defaultActor,
    action,
    entity: "inquiry",
    entityId: inquiryId,
    correlationId: ctx.correlationId,
    data: { inquiry_id: inquiryId, ...data },
  });
}

/**
 * Moves an inquiry along the pure transition table with a compare-and-set on the stored status, so two callers cannot both
 * apply a move from the same state. Returns the state the inquiry is in afterwards and whether this call changed it.
 */
export async function transitionInquiry(
  db: SupabaseClient,
  inquiryId: string,
  event: InquiryEvent,
  ctx: ServiceContext,
  actor: string,
): Promise<{ ok: true; status: InquiryStatus; changed: boolean } | { ok: false; code: "INQUIRY_NOT_FOUND" | "ILLEGAL_TRANSITION"; status?: InquiryStatus }> {
  const inquiry = await loadInquiry(db, inquiryId);
  if (!inquiry) return { ok: false, code: "INQUIRY_NOT_FOUND" };
  const next = inquiryTransition(inquiry.status, event);
  if (typeof next !== "string") return { ok: false, code: "ILLEGAL_TRANSITION", status: inquiry.status };
  if (next === inquiry.status) return { ok: true, status: next, changed: false };

  const updated = await db.from("inquiries").update({ status: next }).eq("id", inquiryId).eq("status", inquiry.status).select("id");
  if (updated.error) throw new Error(`update inquiry: ${updated.error.message}`);
  if ((updated.data ?? []).length === 0) {
    // Someone else moved it first: report where it is now and let the caller decide.
    const now = await loadInquiry(db, inquiryId);
    return { ok: true, status: now?.status ?? next, changed: false };
  }
  await auditIntake(db, ctx, actor, "intake.state_changed", inquiryId, { from: inquiry.status, to: next });
  return { ok: true, status: next, changed: true };
}

export type LatestRequirements = { id: string; version: number; stored: StoredRequirements };

export async function latestRequirements(db: SupabaseClient, inquiryId: string): Promise<LatestRequirements | null> {
  const found = await db.from("requirement_versions").select("id, version, requirements").eq("inquiry_id", inquiryId).order("version", { ascending: false }).limit(1).maybeSingle();
  if (found.error) throw new Error(`load requirements: ${found.error.message}`);
  if (!found.data) return null;
  const parsed = storedRequirementsSchema.safeParse(found.data.requirements);
  if (!parsed.success) throw new Error("stored requirements are not in the expected shape");
  return { id: found.data.id as string, version: found.data.version as number, stored: parsed.data };
}

const UNIQUE_VIOLATION = "23505";
const APPEND_ATTEMPTS = 10;

/**
 * Writes the next requirements version. `build` receives the latest version (or null) and returns the document to store, so a
 * retry after losing a race to another writer rebuilds from the newer version and no edit is lost. Versions are never edited.
 */
export async function appendRequirements(
  db: SupabaseClient,
  inquiryId: string,
  build: (latest: LatestRequirements | null) => StoredRequirements,
  sourceMessageId: string | null,
): Promise<{ id: string; version: number; stored: StoredRequirements }> {
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
    const latest = await latestRequirements(db, inquiryId);
    const stored = build(latest);
    const version = (latest?.version ?? 0) + 1;
    const inserted = await db.from("requirement_versions").insert({ inquiry_id: inquiryId, version, requirements: stored, source_message_id: sourceMessageId }).select("id").single();
    if (!inserted.error) return { id: inserted.data.id as string, version, stored };
    if (inserted.error.code !== UNIQUE_VIOLATION) throw new Error(`save requirements: ${inserted.error.message}`);
  }
  throw new Error("save requirements: too many concurrent writers");
}

export const saveRequirements = (db: SupabaseClient, inquiryId: string, stored: StoredRequirements, sourceMessageId: string | null) =>
  appendRequirements(db, inquiryId, () => stored, sourceMessageId);
