// Audit payloads are allowlisted: a key not listed here is dropped, so new fields
// must be added deliberately. Keys that look like secrets are dropped even if listed.
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "state",
  "from",
  "to",
  "status",
  "operation",
  "decision",
  "reason",
  "code",
  "amount_minor",
  "currency",
  "quote_version",
  "quote_hash",
  "purchase_id",
  "inquiry_id",
  "reservation_id",
  "payment_attempt_id",
  "product_ids",
  "provider_event_id",
  "event_type",
  "evidence",
]);

const SECRET_KEY = /secret|token|password|authorization|api[_-]?key|credential/i;
const MAX_STRING = 200;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function clean(value: unknown): Json | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(clean).filter((v): v is Json => v !== undefined);
    return items;
  }
  if (typeof value === "object") return redact(value as Record<string, unknown>);
  return undefined;
}

export function redact(data: Record<string, unknown> | undefined): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (!data) return out;
  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_KEYS.has(key) || SECRET_KEY.test(key)) continue;
    const cleaned = clean(value);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

export type AuditEvent = {
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  correlationId: string;
  data?: Record<string, unknown>;
};

/** Row shape for the audit_events table (created in the database tasks). */
export type AuditRow = {
  actor: string;
  action: string;
  entity: string;
  entity_id: string;
  correlation_id: string;
  data: Record<string, Json>;
};

export type AuditInsert = (row: AuditRow) => Promise<void>;

/** Writes one redacted audit row. Insert failures propagate so the caller decides how to react. */
export async function audit(insert: AuditInsert, event: AuditEvent): Promise<void> {
  await insert({
    actor: event.actor,
    action: event.action,
    entity: event.entity,
    entity_id: event.entityId,
    correlation_id: event.correlationId,
    data: redact(event.data),
  });
}
