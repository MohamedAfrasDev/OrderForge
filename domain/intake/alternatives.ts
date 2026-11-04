import { z } from "zod";
import type { Alternative } from "@/domain/catalog";
import { acceptExplanation } from "./questions";

const MAX_RANKED = 20;

/** What the model may return when ranking code's options: indexes into code's list and a sentence each. Nothing else. */
export const rankingSchema = z.strictObject({
  ranking: z.array(z.strictObject({ index: z.number().int().min(0), explanation: z.string().max(1000) })).max(MAX_RANKED),
});

export type RankingInput = { ranking: ReadonlyArray<{ index: unknown; explanation: unknown }> } | null | undefined;

/** `index` is the option's position in code's own list, which is also its stable key for the customer to pick. */
export type RankedAlternative<T> = { index: number; item: T; explanation: string | null };

/** Every figure code produced for an option: per-box price, total, the size of the change and each line's price. */
export function amountsOfAlternative(alt: Alternative): number[] {
  return [alt.priced.perBoxMinor, alt.priced.totalMinor, Math.abs(alt.perBoxDeltaMinor), ...alt.priced.lines.map((l) => l.unitPriceMinor)];
}

/**
 * The model orders and explains; code's list is never lost. The result holds exactly code's entries: in the model's order for
 * the indexes it gave validly (an invented, out-of-range, fractional or repeated index is dropped), then whatever it left out in
 * code's own order. An explanation is kept only if `acceptExplanation` passes against the figures code produced for that option,
 * otherwise the option is shown without one. Nothing the model says can add, change or price an option.
 */
export function rankAlternatives<T>(codeList: readonly T[], ranking: RankingInput, amountsOf: (item: T) => readonly number[]): Array<RankedAlternative<T>> {
  const out: Array<RankedAlternative<T>> = [];
  const used = new Set<number>();

  for (const entry of ranking?.ranking ?? []) {
    const index = entry.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= codeList.length || used.has(index)) continue;
    used.add(index);
    const item = codeList[index] as T;
    out.push({ index, item, explanation: acceptExplanation(entry.explanation, amountsOf(item)) });
  }
  codeList.forEach((item, index) => {
    if (!used.has(index)) out.push({ index, item, explanation: null });
  });
  return out;
}
