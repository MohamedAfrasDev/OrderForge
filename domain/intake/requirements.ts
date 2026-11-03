import type { Requirements } from "@/domain/catalog";
import { cents } from "@/lib/money";
import { BLOCKING_FIELDS, FIELD_NAMES, type BlockingField, type Extraction, type Field, type RequirementsDoc } from "./types";

const unknownField = <T>(): Field<T> => ({ value: null, status: "unknown", source: null });

/** Nothing known yet. */
export function emptyRequirements(): RequirementsDoc {
  return {
    boxCount: unknownField(),
    noFood: unknownField(),
    logoRequired: unknownField(),
    maxPricePerBoxMinor: unknownField(),
    requestedPickupDate: unknownField(),
    preferences: unknownField(),
  };
}

const copyField = <T>(f: Field<T>): Field<T> => ({ value: Array.isArray(f.value) ? ([...f.value] as unknown as T) : f.value, status: f.status, source: f.source });

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The next version of the requirements after one customer message. Returns a new document and never changes its inputs.
 *  - A field the model says nothing about, or reports as unknown, keeps its earlier value: a message that does not mention the
 *    budget must not erase it.
 *  - A customer's own edit outranks the model. If the model agrees, nothing changes; if a later message gives a different
 *    value, code (not the model) marks the field conflicted so the customer is asked which one is meant.
 *  - Anything else takes the model's value and status, with the message it came from. `preferences` is replaced by the
 *    model's full list when it gives one.
 */
export function mergeRequirements(previous: RequirementsDoc | null, extraction: Extraction, messageId: string): RequirementsDoc {
  const base = previous ?? emptyRequirements();
  const next = emptyRequirements() as Record<string, Field<unknown>>;

  for (const name of FIELD_NAMES) {
    const before = copyField(base[name] as Field<unknown>);
    const reported = extraction[name] as { value: unknown; status: Field<unknown>["status"] } | undefined;
    if (!reported || reported.status === "unknown") {
      next[name] = before;
      continue;
    }
    if (before.source === "customer_edit" && before.status === "confirmed") {
      next[name] = sameValue(before.value, reported.value) ? before : { value: reported.value, status: "conflicted", source: messageId };
      continue;
    }
    next[name] = { value: Array.isArray(reported.value) ? [...reported.value] : reported.value, status: reported.status, source: messageId };
  }
  return next as unknown as RequirementsDoc;
}

/**
 * What stops a quote, decided by code, in a fixed order so the first question is always the same one:
 * the quantity unless it is confirmed with a value; then any other field that is conflicted or needs confirmation.
 * An unknown budget, date, food or logo preference does not block (it is "not specified"), and soft preferences never do.
 */
export function blockingFields(doc: RequirementsDoc): BlockingField[] {
  const blocking: BlockingField[] = [];
  for (const name of BLOCKING_FIELDS) {
    const f = doc[name];
    if (name === "boxCount") {
      if (f.status !== "confirmed" || f.value === null) blocking.push(name);
    } else if (f.status === "conflicted" || f.status === "needs_confirmation") {
      blocking.push(name);
    }
  }
  return blocking;
}

/** The quantity, only when it is confirmed. */
export function confirmedBoxCount(doc: RequirementsDoc): number | null {
  return doc.boxCount.status === "confirmed" ? doc.boxCount.value : null;
}

/**
 * The requirements the catalog engine validates against. Unknown means not specified: no food restriction, no logo, no budget
 * cap, no date. Only confirmed values are passed on, so a doubtful budget or date can never silently narrow a configuration.
 */
export function toCatalogRequirements(doc: RequirementsDoc): Requirements {
  const requirements: Requirements = {
    noFood: doc.noFood.status === "confirmed" && doc.noFood.value === true,
    logoRequired: doc.logoRequired.status === "confirmed" && doc.logoRequired.value === true,
  };
  if (doc.maxPricePerBoxMinor.status === "confirmed" && doc.maxPricePerBoxMinor.value !== null) {
    requirements.maxPricePerBoxMinor = cents(doc.maxPricePerBoxMinor.value);
  }
  if (doc.requestedPickupDate.status === "confirmed" && doc.requestedPickupDate.value !== null) {
    requirements.requestedPickupDate = doc.requestedPickupDate.value;
  }
  return requirements;
}
