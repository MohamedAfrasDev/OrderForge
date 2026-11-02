import type { Condition, ConditionCode } from "./types";

/** Conditions the merchant must resolve before a quote can be published. The others may be disclosed on the quote instead. */
const MANDATORY: ReadonlySet<ConditionCode> = new Set<ConditionCode>(["UNSUPPORTED_CUSTOMIZATION"]);

export type PublishGate = { canAutoPublish: boolean; mandatoryUnresolved: Condition[] };

export function gateForPublish(conditions: readonly Condition[]): PublishGate {
  const mandatoryUnresolved = conditions.filter((c) => MANDATORY.has(c.code));
  return { canAutoPublish: mandatoryUnresolved.length === 0, mandatoryUnresolved };
}
