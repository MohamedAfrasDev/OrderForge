import { calculateQuote, type Catalog } from "@/domain/catalog";
import type { BlockingField, FieldName, FieldStatus, Proposal } from "@/domain/intake";
import type { Outcome, TurnExpect } from "./scenarios";

/** What one customer message led to, read back from the database after the turn. */
export type Observed = {
  outcome: Outcome;
  /** The coded result when the turn failed (a model outage, unusable output). */
  code?: string;
  askedField?: BlockingField;
  fields: Record<FieldName, { value: unknown; status: FieldStatus }>;
  proposal: Pick<Proposal, "selections" | "status" | "blockers" | "priced" | "alternatives"> | null;
  /** What the assistant said back, or null when it did not answer. */
  reply: string | null;
  inquiryStatus: string;
};

export type Verdict = {
  /** Where the outcome differs from the one stated for the scenario: a result about the model. */
  misses: string[];
  /** Where something the code guarantees did not hold: a bug in the pipeline, whatever the model did. */
  violations: string[];
};

const minorOf = (text: string): number[] =>
  [...text.matchAll(/\$\s?(\d[\d,]*)(?:\.(\d{1,2}))?/g)].map((m) => Number(m[1]!.replace(/,/g, "")) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0));

/**
 * What code guarantees whatever the model says: every figure shown is the catalog engine's for the box shown, every product is a
 * real product allowed in its slot, nothing the customer reads carries an amount code did not produce, and a turn never makes a
 * quote ready. Returns the ways this turn broke any of it (none, when the pipeline is sound).
 */
export function invariantViolations(observed: Observed, catalog: Catalog): string[] {
  const violations: string[] = [];
  const known = new Map(catalog.products.map((p) => [p.sku, p]));
  const allowed = new Map(catalog.slots.map((s) => [s.id, new Set(s.allowedSkus)]));
  const figures = new Set<number>();

  const proposal = observed.proposal;
  if (proposal) {
    for (const [slot, sku] of Object.entries(proposal.selections)) {
      if (!known.has(sku)) violations.push(`the proposal names a product that does not exist: ${sku}`);
      else if (!allowed.get(slot)?.has(sku)) violations.push(`the proposal puts ${sku} in slot ${slot}, which does not allow it`);
    }
    const boxCount = observed.fields.boxCount.value;
    if (proposal.priced) {
      figures.add(proposal.priced.perBoxMinor).add(proposal.priced.totalMinor);
      if (proposal.status !== "VALID") violations.push("a priced proposal that is not valid");
      try {
        const engine = calculateQuote({ boxCount: proposal.priced.boxCount, selections: proposal.selections }, catalog);
        if (engine.perBoxMinor !== proposal.priced.perBoxMinor || engine.totalMinor !== proposal.priced.totalMinor) violations.push("the price shown differs from the catalog engine's for the same box");
        if (typeof boxCount === "number" && boxCount !== proposal.priced.boxCount) violations.push("the priced quantity differs from the confirmed quantity");
      } catch {
        violations.push("the proposal could not be priced by the catalog engine");
      }
    } else if (proposal.status === "VALID") {
      violations.push("a valid proposal with no price");
    }
    for (const alt of proposal.alternatives) {
      figures.add(alt.perBoxMinor).add(alt.totalMinor);
      if (!allowed.get(alt.slotId)?.has(alt.toSku)) violations.push(`an alternative puts ${alt.toSku} in slot ${alt.slotId}, which does not allow it`);
      try {
        const swapped = calculateQuote({ boxCount: typeof boxCount === "number" ? boxCount : 1, selections: { ...proposal.selections, [alt.slotId]: alt.toSku } }, catalog);
        if (typeof boxCount === "number" && (swapped.perBoxMinor !== alt.perBoxMinor || swapped.totalMinor !== alt.totalMinor)) violations.push(`an alternative's price differs from the catalog engine's (${alt.toSku})`);
      } catch {
        violations.push(`an alternative could not be priced (${alt.toSku})`);
      }
    }
  }

  if (observed.reply) {
    for (const amount of minorOf(observed.reply)) {
      if (!figures.has(amount)) violations.push(`the reply states an amount code did not produce: ${amount} cents`);
    }
  }
  if (observed.inquiryStatus === "QUOTE_READY") violations.push("a turn left a quote ready");
  return violations;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Compares one turn with the outcome stated for it. Lists every difference; an empty list means it matches. */
export function outcomeMisses(expect: TurnExpect, observed: Observed): string[] {
  const misses: string[] = [];
  if (observed.outcome !== expect.outcome) {
    misses.push(`expected ${expect.outcome}, got ${observed.outcome}${observed.code ? ` (${observed.code})` : ""}`);
    return misses; // the rest describes a different outcome
  }
  if (expect.askedField && observed.askedField !== expect.askedField) misses.push(`asked about ${observed.askedField ?? "nothing"}, expected ${expect.askedField}`);

  const proposal = observed.proposal;
  if (expect.proposal && proposal?.status !== expect.proposal) misses.push(`proposal was ${proposal?.status ?? "absent"}, expected ${expect.proposal}`);
  for (const code of expect.blockersInclude ?? []) if (!proposal?.blockers.includes(code)) misses.push(`blockers did not include ${code} (${proposal?.blockers.join(", ") || "none"})`);
  for (const sku of expect.alternativesInclude ?? []) if (!proposal?.alternatives.some((a) => a.toSku === sku)) misses.push(`alternatives did not include ${sku}`);
  if (expect.perBoxMinor !== undefined && proposal?.priced?.perBoxMinor !== expect.perBoxMinor) misses.push(`price per box was ${proposal?.priced?.perBoxMinor ?? "absent"}, expected ${expect.perBoxMinor}`);
  for (const [slot, sku] of Object.entries(expect.selections ?? {})) if (proposal?.selections[slot] !== sku) misses.push(`slot ${slot} held ${proposal?.selections[slot] ?? "nothing"}, expected ${sku}`);
  for (const [name, value] of Object.entries(expect.values ?? {})) {
    const f = observed.fields[name as FieldName];
    if (!same(f.value, value) || f.status !== "confirmed") misses.push(`${name} was ${JSON.stringify(f.value)} (${f.status}), expected ${JSON.stringify(value)} confirmed`);
  }
  for (const name of expect.notConfirmed ?? []) if (observed.fields[name].status === "confirmed") misses.push(`${name} was confirmed, expected it to stay open`);
  return misses;
}

export function judgeTurn(expect: TurnExpect, observed: Observed, catalog: Catalog): Verdict {
  return { misses: outcomeMisses(expect, observed), violations: invariantViolations(observed, catalog) };
}
