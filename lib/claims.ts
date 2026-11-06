// Pure scanner for claims nobody measured. The project's claims policy: everything is sandbox-only with synthetic data, and no
// claim about time saved, demand, cost, errors or accuracy is made unless this repository measured it and states the method beside it.
// Pages and documents written for visitors and judges are checked against this list by tests; the generated proof file is not
// (its numbers come from a command, with the method in the file).

export const CLAIM_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "saving", pattern: /\bsav(e|es|ed|ing|ings)\b/i },
  { name: "speed", pattern: /\b(faster|quicker|quickly|instantly)\b/i },
  { name: "increase", pattern: /\b(increas(e|es|ed|ing)|boost(s|ed|ing)?)\b/i },
  { name: "social proof", pattern: /\btrusted by\b/i },
  { name: "guarantee", pattern: /\bguarantee(s|d)?\b/i },
  { name: "percentage", pattern: /\d+(\.\d+)?\s?%/ },
  { name: "multiplier", pattern: /\b\d+x\b|\btimes\b/i },
  { name: "reduction", pattern: /\b(reduc(e|es|ed|ing)|cut(s|ting)?|lower(s|ed|ing)?)\s+(\w+\s+)?(cost|costs|time|errors|mistakes|work|effort)\b/i },
  { name: "elimination", pattern: /\beliminat(e|es|ed|ing)\b/i },
];

/** The names of every unmeasured-claim pattern the text matches (empty when the text makes none). */
export function claimsIn(text: string): string[] {
  return CLAIM_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}
