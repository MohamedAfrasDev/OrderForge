import { proposeAlternatives, validateConfiguration } from "@/domain/catalog";
import type { Blocker, Catalog, PricedConfiguration, Requirements, Stock } from "@/domain/catalog/types";
import type { Proposal } from "@/domain/intake";
import { cents } from "@/lib/money";
import type { AgentBody } from "./schema";

const MAX_ALTERNATIVES = 5;

export type AgentLine = { slotId: string; sku: string; name: string; unitPriceMinor: number; quantity: number };

/** A box code has chosen and priced. Every amount is an integer number of cents, from the catalog engine. */
export type AgentProposal = {
  kind: "BOX" | "SWAP";
  lines: AgentLine[];
  perBoxMinor: number;
  totalMinor: number;
  boxCount: number;
  currency: "USD";
  /** For a SWAP: the one part of the first box that was replaced. */
  swap?: { slotId: string; fromSku: string; toSku: string };
};

export type ProposedForRequest = {
  status: "VALID" | "BLOCKED";
  selections: Record<string, string>;
  /** Why the first box could not be made (coded; empty when it can). */
  blockers: Blocker[];
  /** The box when it is valid; otherwise the options code found (possibly none). */
  proposals: AgentProposal[];
  /** The same thing in the form the order room stores and reads. */
  stored: Proposal;
};

/** Code's choice for each part of the box: the first allowed product that is active and, for a no-food request, not food. */
export function defaultSelections(catalog: Catalog, noFood: boolean): Record<string, string> {
  const bySku = new Map(catalog.products.map((p) => [p.sku, p]));
  const selections: Record<string, string> = {};
  for (const slot of catalog.slots) {
    const fit = slot.allowedSkus.find((sku) => {
      const p = bySku.get(sku);
      return p !== undefined && p.active && !(noFood && p.isFood);
    });
    const choice = fit ?? slot.allowedSkus[0];
    if (choice !== undefined) selections[slot.id] = choice;
  }
  return selections;
}

const toProposal = (priced: PricedConfiguration, kind: AgentProposal["kind"], swap?: AgentProposal["swap"]): AgentProposal => ({
  kind,
  lines: priced.lines.map((l) => ({ slotId: l.slotId, sku: l.sku, name: l.name, unitPriceMinor: l.unitPriceMinor, quantity: l.quantity })),
  perBoxMinor: priced.perBoxMinor,
  totalMinor: priced.totalMinor,
  boxCount: priced.boxCount,
  currency: priced.currency,
  ...(swap ? { swap } : {}),
});

/**
 * The whole proposal step for an agent request, in code: choose a box, validate and price it with the catalog engine (the same functions the
 * web flow uses), and when it cannot be made ask the engine for the valid single swaps. No model is involved, nothing is read from the clock
 * (`today` is passed in), and the same input always gives the same answer.
 */
export function proposeForRequest(input: { body: AgentBody; catalog: Catalog; stock: Stock; today: string }): ProposedForRequest {
  const { body, catalog, stock, today } = input;
  const requirements: Requirements = {
    noFood: body.noFood,
    logoRequired: body.logoRequired,
    maxPricePerBoxMinor: cents(body.maxPricePerBoxMinor),
    ...(body.requestedPickupDate ? { requestedPickupDate: body.requestedPickupDate } : {}),
  };
  const selections = defaultSelections(catalog, body.noFood);
  const validation = { configuration: { boxCount: body.boxCount, selections }, catalog, requirements, stock, today };

  const checked = validateConfiguration(validation);
  if (checked.ok) {
    const { perBoxMinor, totalMinor, boxCount } = checked.priced;
    return {
      status: "VALID",
      selections,
      blockers: [],
      proposals: [toProposal(checked.priced, "BOX")],
      stored: { selections, status: "VALID", blockers: [], priced: { perBoxMinor, totalMinor, boxCount }, alternatives: [] },
    };
  }

  const found = proposeAlternatives(validation, { limit: MAX_ALTERNATIVES }).alternatives;
  return {
    status: "BLOCKED",
    selections,
    blockers: checked.blockers,
    proposals: found.map((a) => toProposal(a.priced, "SWAP", { slotId: a.slotId, fromSku: a.fromSku, toSku: a.toSku })),
    stored: {
      selections,
      status: "BLOCKED",
      blockers: [...new Set(checked.blockers.map((b) => b.code))],
      priced: null,
      alternatives: found.map((a, index) => ({
        key: `alt-${index}`,
        slotId: a.slotId,
        fromSku: a.fromSku,
        toSku: a.toSku,
        perBoxMinor: a.priced.perBoxMinor,
        totalMinor: a.priced.totalMinor,
        explanation: null,
      })),
    },
  };
}
