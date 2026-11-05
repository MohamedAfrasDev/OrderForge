import { cents, format } from "@/lib/money";
import type { BlockingField, FieldName, RequirementsDoc } from "./types";

export type QuickChoice = { label: string; edit: Record<string, unknown> };

export type QuickReplies = {
  field: BlockingField;
  /** What kind of box goes with the choices: a number, dollars, a date, or just the choices. */
  kind: "number" | "money" | "date" | "choice";
  choices: QuickChoice[];
};

const BOX_PRESETS = [10, 20, 50] as const;
const BUDGET_PRESETS_MINOR = [2500, 4000, 6000] as const;

const dollars = (minor: number) => format(cents(minor));

/**
 * The tappable answers shown under the one question the assistant is waiting on. Decided by code from the open field and the value
 * the assistant guessed (so one tap can confirm a guess), never by the model. A tap is the customer's own confirmed answer: every
 * choice is a single edit of that one field and is one the strict edit rules accept (a clearing choice sets the field to nothing).
 */
export function quickRepliesFor(question: { field: BlockingField }, fields: RequirementsDoc): QuickReplies {
  const { field } = question;
  switch (field) {
    case "boxCount": {
      const guess = fields.boxCount.value;
      const presets = BOX_PRESETS.filter((n) => n !== guess);
      return {
        field,
        kind: "number",
        choices: [
          ...(typeof guess === "number" ? [{ label: `Yes, ${guess} boxes`, edit: { boxCount: guess } }] : []),
          ...presets.map((n) => ({ label: `${n} boxes`, edit: { boxCount: n } })),
        ],
      };
    }
    case "maxPricePerBoxMinor": {
      const guess = fields.maxPricePerBoxMinor.value;
      const presets = BUDGET_PRESETS_MINOR.filter((n) => n !== guess);
      return {
        field,
        kind: "money",
        choices: [
          ...(typeof guess === "number" ? [{ label: `Yes, up to ${dollars(guess)} a box`, edit: { maxPricePerBoxMinor: guess } }] : []),
          ...presets.map((n) => ({ label: `Up to ${dollars(n)} a box`, edit: { maxPricePerBoxMinor: n } })),
          { label: "No limit", edit: { maxPricePerBoxMinor: null } },
        ],
      };
    }
    case "noFood":
      return {
        field,
        kind: "choice",
        choices: [
          { label: "Yes, no food", edit: { noFood: true } },
          { label: "Food is fine", edit: { noFood: false } },
        ],
      };
    case "logoRequired":
      return {
        field,
        kind: "choice",
        choices: [
          { label: "Yes, add our logo", edit: { logoRequired: true } },
          { label: "No logo needed", edit: { logoRequired: false } },
        ],
      };
    case "requestedPickupDate": {
      const guess = fields.requestedPickupDate.value;
      return {
        field,
        kind: "date",
        choices: [
          ...(typeof guess === "string" ? [{ label: `Yes, ${guess}`, edit: { requestedPickupDate: guess } }] : []),
          { label: "Any day", edit: { requestedPickupDate: null } },
        ],
      };
    }
  }
}

export type ParsedAnswer = { ok: true; value: unknown } | { ok: false };

const NOT_OK: ParsedAnswer = { ok: false };

/**
 * Reads what a customer typed for one line of their order, as text from a form. Blank means "clear it" (the value null). Anything
 * that is not clearly the kind of value the line holds is refused here; the strict edit rules then check it again.
 */
export function parseAnswer(field: FieldName, raw: string): ParsedAnswer {
  const text = raw.trim();
  switch (field) {
    case "boxCount": {
      if (text === "") return { ok: true, value: null };
      if (!/^\d{1,7}$/.test(text) || Number(text) < 1) return NOT_OK;
      return { ok: true, value: Number(text) };
    }
    case "maxPricePerBoxMinor": {
      if (text === "") return { ok: true, value: null };
      const found = /^\$?(\d{1,6})(?:\.(\d{1,2}))?$/.exec(text);
      if (!found) return NOT_OK;
      const minor = Number(found[1]) * 100 + Number((found[2] ?? "").padEnd(2, "0") || 0);
      return minor >= 1 ? { ok: true, value: minor } : NOT_OK;
    }
    case "noFood":
    case "logoRequired":
      if (text === "") return { ok: true, value: null };
      return text === "yes" ? { ok: true, value: true } : text === "no" ? { ok: true, value: false } : NOT_OK;
    case "requestedPickupDate":
      if (text === "") return { ok: true, value: null };
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { ok: true, value: text } : NOT_OK;
    case "preferences": {
      const items = text.split(",").map((p) => p.trim()).filter(Boolean);
      if (items.length === 0) return { ok: true, value: null };
      return items.length <= 10 && items.every((p) => p.length <= 80) ? { ok: true, value: items } : NOT_OK;
    }
  }
}
