/**
 * Dollars and cents the way a person types them, as whole cents: "12", "12.5", "12.50", "$1,200.00". Strict, with no rounding: a third decimal,
 * a negative, a letter, an empty string or an exponent is not a price (null), so a typo can never become a different amount.
 */
export function parseDollars(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const cleaned = text.trim().replace(/^\$\s*/, "");
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]!.replace(/,/g, ""));
  const fraction = match[2] ? Number(match[2].padEnd(2, "0")) : 0;
  const total = whole * 100 + fraction;
  return Number.isSafeInteger(total) ? total : null;
}

/** Whole cents as plain dollars for an edit box: 1300 becomes "13.00". */
export function dollarsText(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** A whole number the way a person types it ("40", " 40 "); anything else is null. */
export function parseWholeNumber(text: unknown): number | null {
  if (typeof text === "number") return Number.isSafeInteger(text) && text >= 0 ? text : null;
  if (typeof text !== "string") return null;
  const cleaned = text.trim();
  return /^\d{1,9}$/.test(cleaned) ? Number(cleaned) : null;
}
