import type { PricedConfiguration } from "@/domain/catalog/types";
import { format } from "@/lib/money";
import { canonicalJson } from "./canonical";
import { QUOTE_SCHEMA_TAG, type Condition, type QuoteSnapshot } from "./types";

export const TERMS_SENTENCE =
  "You are authorizing this exact proposal, subject to the merchant confirming the listed production conditions.";

export type SnapshotInput = {
  merchantId: string;
  inquiryId: string;
  version: number;
  requirementVersionId: string | null;
  priced: PricedConfiguration;
  conditions: readonly Condition[];
};

function compareConditions(a: Condition, b: Condition): number {
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
}

/** The exact object that is hashed. Copies only covered fields, so stray properties can never reach the hash. */
export function buildQuoteSnapshot(input: SnapshotInput): QuoteSnapshot {
  const { priced } = input;
  return {
    schema: QUOTE_SCHEMA_TAG,
    merchantId: input.merchantId,
    inquiryId: input.inquiryId,
    version: input.version,
    requirementVersionId: input.requirementVersionId,
    boxCount: priced.boxCount,
    perBoxMinor: priced.perBoxMinor,
    totalMinor: priced.totalMinor,
    currency: priced.currency,
    lines: priced.lines.map((l) => ({
      slotId: l.slotId,
      sku: l.sku,
      name: l.name,
      unitPriceMinor: l.unitPriceMinor,
      quantity: l.quantity,
    })),
    conditions: input.conditions.map((c) => ({ code: c.code, text: c.text })).sort(compareConditions),
  };
}

/** SHA-256 hex over the canonical JSON. The hash primitive is passed in so the domain stays free of Node imports. */
export function quoteHash(snapshot: QuoteSnapshot, sha256: (text: string) => string): string {
  return sha256(canonicalJson(snapshot));
}

/** The wording the customer sees and the approval stores. Built in code from one template plus the disclosed conditions. */
export function renderTerms(snapshot: QuoteSnapshot): string {
  const boxes = snapshot.boxCount === 1 ? "1 box" : `${snapshot.boxCount} boxes`;
  const lines = [
    `Quote version ${snapshot.version}: ${boxes} at ${format(snapshot.perBoxMinor)} per box, ${format(snapshot.totalMinor)} total (${snapshot.currency}).`,
    TERMS_SENTENCE,
  ];
  if (snapshot.conditions.length === 0) {
    lines.push("No conditions are pending.");
  } else {
    lines.push("Conditions disclosed on this quote:");
    for (const c of snapshot.conditions) lines.push(`- ${c.text}`);
  }
  return lines.join("\n");
}
