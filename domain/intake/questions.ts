import { z } from "zod";
import type { BlockingField } from "./types";

/** What the model may return when asked to word a question. Only the question: nowhere to put a price or a state. */
export const askSchema = z.strictObject({ question: z.string().max(1000) });

const MAX_QUESTION_LENGTH = 300;
const MAX_EXPLANATION_LENGTH = 600;

const FALLBACK: Record<BlockingField, string> = {
  boxCount: "How many boxes would you like?",
  noFood: "Should the boxes be free of any food items?",
  logoRequired: "Do you want your company logo on the boxes?",
  maxPricePerBoxMinor: "What is the most you want to spend per box?",
  requestedPickupDate: "By what date do you need to collect the order?",
};

/** Fixed wording for the one question code decided to ask. Always available, with or without a model. */
export function fallbackQuestion(field: BlockingField): string {
  return FALLBACK[field];
}

/** A question about this field has to be about this field. */
const TOPIC: Record<BlockingField, RegExp> = {
  boxCount: /\bhow many\b|\bquantity\b|\bnumber of\b/i,
  noFood: /\bfood\b/i,
  logoRequired: /\blogo\b/i,
  maxPricePerBoxMinor: /\b(budget|spend|price|cost)\b/i,
  requestedPickupDate: /\b(date|when|collect|pick ?up)\b/i,
};

const SENSITIVE = /password|passcode|credit|debit|\bcard number\b|\bcard\b.*\b(number|details)\b|\baccount\b|\bbank\b|\biban\b|\bssn\b|social security|\baddress\b|\bphone\b|\be-?mail\b|\bpin\b/i;
const SKU_LIKE = /\b[A-Z0-9]{2,}-[A-Z0-9]{2,}\b/;
const MARKUP = /[<>`[\]{}\\]/;
const LINK = /https?:|www\.|:\/\//i;
const CURRENCY = /[$€£¥]/;

/**
 * The model may reword the fixed question; its wording is shown only if it is still exactly one plain question about the same
 * field: one sentence ending in a question mark, at most 300 characters, no markup or links, no figures of its own (no digits,
 * currency symbols or SKUs, so no price, quantity or stock number can be invented), nothing sensitive, and on topic.
 * Returns the trimmed text, or null (callers then use `fallbackQuestion`).
 */
export function acceptQuestion(text: unknown, field: BlockingField): string | null {
  if (typeof text !== "string") return null;
  const q = text.trim();
  if (q.length < 5 || q.length > MAX_QUESTION_LENGTH) return null;
  if (/[\r\n]/.test(q)) return null;
  if (!q.endsWith("?") || (q.match(/\?/g) ?? []).length !== 1) return null;
  if (/[.!;]/.test(q)) return null;
  if (/\d/.test(q) || CURRENCY.test(q) || SKU_LIKE.test(q)) return null;
  if (MARKUP.test(q) || LINK.test(q)) return null;
  if (SENSITIVE.test(q)) return null;
  if (!TOPIC[field].test(q)) return null;
  return q;
}

const PROMISE = /%|discount|coupon|promo|\bfor free\b|free of charge|free shipping|complimentary|refund|waive/i;
const OTHER_CURRENCY = /[€£¥]/;
const EXPLANATION_MARKUP = /[<>`]/;

function minorOf(whole: string, fraction: string | undefined): number {
  const units = Number(whole.replace(/,/g, ""));
  const cents = fraction === undefined ? 0 : Number(fraction.padEnd(2, "0"));
  return units * 100 + cents;
}

/**
 * The model may explain why an option is a good one, but it may not speak about money in its own words. A sentence is shown
 * only if every amount in it (a $ amount, "N dollars", "N USD", "N cents") is one of the figures code produced
 * (`knownAmountsMinor`, compared by size, in minor units), and it makes no promise about discounts, free offers, refunds or
 * percentages. No markup, at most 600 characters. Returns the trimmed text, or null.
 */
export function acceptExplanation(text: unknown, knownAmountsMinor: readonly number[]): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t.length < 1 || t.length > MAX_EXPLANATION_LENGTH) return null;
  if (EXPLANATION_MARKUP.test(t) || OTHER_CURRENCY.test(t) || PROMISE.test(t)) return null;

  const known = new Set(knownAmountsMinor.map((n) => Math.abs(n)));
  const found: number[] = [];
  for (const m of t.matchAll(/\$\s?(\d[\d,]*)(?:\.(\d{1,2}))?/g)) found.push(minorOf(m[1]!, m[2]));
  for (const m of t.matchAll(/(\d[\d,]*)(?:\.(\d{1,2}))?\s*(?:usd|dollars?|bucks)\b/gi)) found.push(minorOf(m[1]!, m[2]));
  for (const m of t.matchAll(/(\d[\d,]*)\s*cents?\b/gi)) found.push(Number(m[1]!.replace(/,/g, "")));
  return found.every((minor) => known.has(minor)) ? t : null;
}
