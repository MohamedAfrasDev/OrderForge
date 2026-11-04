import { z } from "zod";
import {
  calculateQuote,
  catalogForModel,
  validateConfiguration,
  type Catalog,
  type ModelCatalogView,
  type PricedConfiguration,
  type Requirements,
  type Stock,
  type ValidationResult,
} from "@/domain/catalog";

/** The only tools an agent turn can use. All read-only: nothing here can create a quote, publish, reserve, pay or change a status. */
export const TOOL_NAMES = ["read_catalog", "validate_configuration", "calculate_quote"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** At most this many tool calls in one turn (assumption 2). */
export const MAX_TOOL_CALLS = 6;

const noArgs = z.strictObject({});
/** The only argument a tool takes from the caller: a SKU per slot. The quantity and the requirements are fixed by code. */
const selectionsArgs = z.strictObject({ selections: z.record(z.string().max(80), z.string().max(80)) });

export type ToolResults = {
  read_catalog: ModelCatalogView;
  validate_configuration: ValidationResult;
  calculate_quote: PricedConfiguration;
};

export type ToolFailure = "UNKNOWN_TOOL" | "INVALID_ARGS" | "TOOL_LIMIT" | "NO_QUANTITY";
export type ToolOutcome<T> = { ok: true; result: T } | { ok: false; code: ToolFailure };

/** What a turn knows, fixed before any tool runs. Callers (the model included) cannot override it through arguments. */
export type ToolContext = { catalog: Catalog; stock: Stock; requirements: Requirements; boxCount: number | null; today: string };

export type ToolDispatcher = {
  call<N extends ToolName>(name: N, args: unknown): ToolOutcome<ToolResults[N]>;
  call(name: string, args: unknown): ToolOutcome<unknown>;
  readonly used: number;
};

/**
 * One door for every catalog read a turn makes. A name outside the allowlist, an argument the strict schema does not accept
 * (a price, a quantity, anything extra), or a call past the budget is refused and does nothing. The budget counts refused
 * calls too, so a caller cannot probe for free.
 */
export function createToolDispatcher(context: ToolContext, maxCalls: number = MAX_TOOL_CALLS): ToolDispatcher {
  let used = 0;

  function call(name: string, args: unknown): ToolOutcome<unknown> {
    used += 1;
    if (used > maxCalls) return { ok: false, code: "TOOL_LIMIT" };
    if (!(TOOL_NAMES as readonly string[]).includes(name)) return { ok: false, code: "UNKNOWN_TOOL" };

    switch (name as ToolName) {
      case "read_catalog": {
        if (!noArgs.safeParse(args ?? {}).success) return { ok: false, code: "INVALID_ARGS" };
        return { ok: true, result: catalogForModel(context.catalog) };
      }
      case "validate_configuration": {
        const parsed = selectionsArgs.safeParse(args);
        if (!parsed.success) return { ok: false, code: "INVALID_ARGS" };
        if (context.boxCount === null) return { ok: false, code: "NO_QUANTITY" };
        const result = validateConfiguration({
          configuration: { boxCount: context.boxCount, selections: parsed.data.selections },
          catalog: context.catalog,
          requirements: context.requirements,
          stock: context.stock,
          today: context.today,
        });
        return { ok: true, result };
      }
      case "calculate_quote": {
        const parsed = selectionsArgs.safeParse(args);
        if (!parsed.success) return { ok: false, code: "INVALID_ARGS" };
        if (context.boxCount === null) return { ok: false, code: "NO_QUANTITY" };
        try {
          return { ok: true, result: calculateQuote({ boxCount: context.boxCount, selections: parsed.data.selections }, context.catalog) };
        } catch {
          return { ok: false, code: "INVALID_ARGS" };
        }
      }
    }
  }

  return {
    call: call as ToolDispatcher["call"],
    get used() {
      return used;
    },
  };
}
