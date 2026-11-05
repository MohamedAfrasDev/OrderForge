const MAX_LENGTH = 254;
// One @, something before it, a dot-separated domain after it, no spaces. Not the whole of RFC 5322: a typo check, not a verifier.
const SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export type OptionalEmail = { ok: true; email: string | null } | { ok: false };

/**
 * What a customer typed in the optional email box. Empty is fine (no address). Anything else is trimmed, lowercased and kept only if it
 * looks like an address (`ok: false` otherwise). The result is what the database accepts.
 */
export function parseOptionalEmail(raw: unknown): OptionalEmail {
  if (raw === null || raw === undefined) return { ok: true, email: null };
  if (typeof raw !== "string") return { ok: false };
  const text = raw.trim().toLowerCase();
  if (text === "") return { ok: true, email: null };
  if (text.length > MAX_LENGTH || text.includes("..") || !SHAPE.test(text)) return { ok: false };
  return { ok: true, email: text };
}
