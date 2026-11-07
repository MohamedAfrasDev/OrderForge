import type { FieldStatus } from "@/domain/intake";

/**
 * Where a fact on the order screen came from, in the customer's words. Three labels, and only these: the assistant read it from a
 * message, the customer set or answered it themselves, or code worked it out from the shop's prices and stock. The meaning is in the
 * words, never in a colour. Pure: it maps what the system already knows and decides nothing.
 */
export const PROVENANCE = ["message", "confirmed", "calculated"] as const;
export type Provenance = (typeof PROVENANCE)[number];

export const PROVENANCE_LABELS = {
  message: { label: "From your message", detail: "The assistant read this from what you wrote." },
  confirmed: { label: "You confirmed", detail: "You set or answered this yourself." },
  calculated: { label: "Calculated by us", detail: "Worked out from the shop's prices and stock, not by the assistant." },
} as const satisfies Record<Provenance, { label: string; detail: string }>;

/** What the order screen knows about one line of the order so far. `source` is "message" (read by the assistant), "edit" (the customer's own) or null. */
export type ProvenanceField = { value: unknown; status: FieldStatus; source: "message" | "edit" | null };

const hasValue = (v: unknown) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);

/**
 * The label for a line of the order so far, or null when no label is honest: nobody gave a value, no source is known, or the system is not
 * sure (an unsure line asks a question instead of claiming where it came from).
 */
export function provenanceOfField(f: ProvenanceField): Provenance | null {
  if (!hasValue(f.value) || f.source === null) return null;
  if (f.status === "conflicted" || f.status === "needs_confirmation" || f.status === "unknown") return null;
  return f.source === "edit" ? "confirmed" : "message";
}

/** Every price, total and item the shop's catalog produced is calculated by code, whatever the assistant said around it. */
export function provenanceOfFigure(): Provenance {
  return "calculated";
}
