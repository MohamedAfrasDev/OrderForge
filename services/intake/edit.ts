import type { SupabaseClient } from "@supabase/supabase-js";
import { FIELD_NAMES, emptyStored, parseExtraction, type FieldName, type IntakeResult, type RequirementsDoc, type StoredRequirements } from "@/domain/intake";
import type { VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { appendRequirements, auditIntake, loadInquiry, transitionInquiry, type ServiceContext } from "./shared";

export type Edits = Partial<Record<FieldName, unknown>>;

/**
 * The customer edits the visible specification. A value sets that field as a confirmed edit (the customer's own word, which
 * outranks the model), null clears it back to not specified. The edits are checked by the same strict rules as the model's
 * answers, so a price, a discount or any other key has nowhere to go. A new version is written on top of the latest one and
 * nothing is lost under concurrent edits; the proposal and question of the earlier version are dropped because they no longer
 * match. Editing after a quote was ready sends the inquiry back to CONFIGURING.
 */
export async function editRequirements(db: SupabaseClient, inquiryId: VerifiedInquiryId, edits: unknown, ctx: ServiceContext): Promise<IntakeResult<{ version: number }>> {
  const inquiry = await loadInquiry(db, inquiryId);
  if (!inquiry) return { ok: false, code: "INQUIRY_NOT_FOUND" };
  if (typeof edits !== "object" || edits === null || Array.isArray(edits)) return { ok: false, code: "INVALID_INPUT" };

  const entries = Object.entries(edits as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, code: "INVALID_INPUT", cause: "nothing to change" };
  const unknownKeys = entries.map(([k]) => k).filter((k) => !(FIELD_NAMES as readonly string[]).includes(k));
  if (unknownKeys.length > 0) return { ok: false, code: "INVALID_INPUT", cause: `unknown field: ${unknownKeys.join(", ")}` };

  const toSet: Record<string, { value: unknown; status: "confirmed" }> = {};
  const toClear: FieldName[] = [];
  for (const [name, value] of entries) {
    if (value === null) toClear.push(name as FieldName);
    else toSet[name] = { value, status: "confirmed" };
  }
  const parsed = parseExtraction(toSet);
  if (!parsed.ok) return { ok: false, code: "INVALID_INPUT", cause: parsed.errors.join("; ").slice(0, 300) };

  const saved = await appendRequirements(
    db,
    inquiryId,
    (latest) => {
      const base: StoredRequirements = latest?.stored ?? emptyStored();
      const fields = { ...base.fields } as Record<string, unknown>;
      for (const name of FIELD_NAMES) {
        const set = (parsed.value as Record<string, { value: unknown } | undefined>)[name];
        if (set) fields[name] = { value: set.value, status: "confirmed", source: "customer_edit" };
        else if (toClear.includes(name)) fields[name] = { value: null, status: "unknown", source: "customer_edit" };
      }
      return { schema: base.schema, fields: fields as unknown as RequirementsDoc, proposal: null, question: null };
    },
    null,
  );

  await auditIntake(db, ctx, `customer:${inquiryId}`, "intake.requirements_edited", inquiryId);
  if (inquiry.status === "QUOTE_READY") await transitionInquiry(db, inquiryId, { type: "CUSTOMER_CHANGE" }, ctx, `customer:${inquiryId}`);
  return { ok: true, value: { version: saved.version } };
}
