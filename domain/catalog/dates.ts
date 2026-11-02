// Plain calendar dates (YYYY-MM-DD, no time zone), computed with UTC calendar math so the machine zone never matters.
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function addDays(date: string, days: number): string {
  if (!isCalendarDate(date)) throw new RangeError(`not a calendar date: ${date}`);
  if (!Number.isInteger(days) || days < 0) throw new RangeError("days must be a non-negative integer");
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const out = new Date(Date.UTC(y, mo - 1, d + days));
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return `${pad(out.getUTCFullYear(), 4)}-${pad(out.getUTCMonth() + 1, 2)}-${pad(out.getUTCDate(), 2)}`;
}
