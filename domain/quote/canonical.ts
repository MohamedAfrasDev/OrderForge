// Canonical JSON for hashing: keys sorted by code point, no whitespace, arrays in order, integers only.
// Anything that cannot be written one single way throws; that is a programmer bug, never a business outcome.

function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ca = ia.next();
    const cb = ib.next();
    if (ca.done || cb.done) return ca.done === cb.done ? 0 : ca.done ? -1 : 1;
    const diff = ca.value.codePointAt(0)! - cb.value.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
}

function write(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new TypeError(`canonicalJson: ${String(value)} is not a canonical integer`);
      }
      return String(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: ${typeof value} is not allowed`);
  }

  const obj = value as object;
  if (seen.has(obj)) throw new TypeError("canonicalJson: circular structure");
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => write(item, seen)).join(",")}]`;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("canonicalJson: only plain objects are allowed");
    }
    const record = obj as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort(compareCodePoints)
      .map((key) => `${JSON.stringify(key)}:${write(record[key], seen)}`);
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

export function canonicalJson(value: unknown): string {
  return write(value, new Set());
}
