"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import type { IntakeState } from "./intake-actions";

type FormAction = (previous: IntakeState, formData: FormData) => Promise<IntakeState>;
type ButtonAction = () => Promise<IntakeState>;

const initial: IntakeState = { status: "idle" };
const field = "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm";

function Problem({ state }: { state: IntakeState }) {
  return state.status === "error" ? (
    <p role="alert" className="text-sm text-destructive">
      {state.message}
    </p>
  ) : null;
}

/** Plain text in, plain text out: the browser sends only what was typed. */
export function MessageForm({ action }: { action: FormAction }) {
  const [state, formAction, pending] = useActionState(action, initial);
  return (
    <form action={formAction} aria-label="New message" className="flex flex-col gap-2">
      <label htmlFor="message" className="text-sm font-medium">
        Write to the assistant
      </label>
      <textarea
        id="message"
        name="message"
        required
        maxLength={4000}
        rows={3}
        className="w-full rounded-lg border border-border bg-background p-3 text-sm"
        key={state.status === "done" ? "sent" : "typing"}
      />
      <p className="text-xs text-muted-foreground">Synthetic data only: don&apos;t enter real personal or payment details. Your message is read by an AI model.</p>
      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send"}
      </Button>
      <Problem state={state} />
    </form>
  );
}

/** "Choose this box": sends which option, never an amount. */
export function ChooseButton({ action, optionKey }: { action: FormAction; optionKey: string }) {
  const [state, formAction, pending] = useActionState(action, initial);
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="key" value={optionKey} />
      <Button type="submit" disabled={pending || state.status === "done"}>
        {pending ? "Preparing your price…" : "Choose this box"}
      </Button>
      <Problem state={state} />
    </form>
  );
}

export function ActionButton({ action, label, pendingLabel, variant = "outline" }: { action: ButtonAction; label: string; pendingLabel: string; variant?: "outline" | "default" }) {
  const [state, formAction, pending] = useActionState(async () => action(), initial);
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? pendingLabel : label}
      </Button>
      <Problem state={state} />
    </form>
  );
}

/** A tappable answer under the open question. It sends only its own position; the server decides what it means. */
export function Chip({ action, label }: { action: ButtonAction; label: string }) {
  const [state, formAction, pending] = useActionState(async () => action(), initial);
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <button type="submit" disabled={pending} className="rounded-full border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">
        {pending ? "One moment…" : label}
      </button>
      <Problem state={state} />
    </form>
  );
}

export type InputKind = "number" | "money" | "date" | "yesno" | "text";

function ValueInput({ kind, defaultValue, label }: { kind: InputKind; defaultValue: string; label: string }) {
  switch (kind) {
    case "number":
      return <input name="value" type="number" min={1} step={1} defaultValue={defaultValue} aria-label={label} className={field} />;
    case "money":
      return <input name="value" type="text" inputMode="decimal" defaultValue={defaultValue} placeholder="For example 40 or 40.50" aria-label={label} className={field} />;
    case "date":
      return <input name="value" type="date" defaultValue={defaultValue} aria-label={label} className={field} />;
    case "yesno":
      return (
        <select name="value" defaultValue={defaultValue} aria-label={label} className={field}>
          <option value="">Tell us later</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    default:
      return <input name="value" type="text" defaultValue={defaultValue} placeholder="Separate with commas" aria-label={label} className={field} />;
  }
}

type LineProps = {
  label: string;
  /** What the line says now, in words, or null when nothing is known yet ("Tell us"). */
  display: string | null;
  /** Where it came from or how sure we are, in words. */
  note: string;
  kind: InputKind;
  /** The value to start the editor with, in the form the box takes (dollars for money). */
  editorValue: string;
  /** The open question is about this line. */
  asked: boolean;
  action: FormAction;
};

/** One line of "Your order so far". Tapping it opens a small editor; saving is the customer's own confirmed answer. */
export function OrderLine({ label, display, note, kind, editorValue, asked, action }: LineProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, initial);
  return (
    <li className="border-t border-border first:border-t-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-start justify-between gap-3 py-2 text-left text-sm">
        <span className="font-medium">{label}</span>
        <span className="flex flex-col items-end gap-0.5 text-right">
          {display === null ? (
            <span className={`rounded border border-dashed px-1.5 py-0.5 ${asked ? "border-primary bg-muted font-medium" : "border-border text-muted-foreground"}`}>Tell us</span>
          ) : (
            <span>{display}</span>
          )}
          {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
        </span>
      </button>
      {open ? (
        <form action={formAction} className="flex flex-col gap-2 pb-3">
          <ValueInput kind={kind} defaultValue={editorValue} label={label} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          <Problem state={state} />
        </form>
      ) : null}
    </li>
  );
}

/** The typed way to answer the open question, next to the tappable choices: a number, a budget in dollars or a date. */
export function AnswerBox({ kind, label, button, action }: { kind: Exclude<InputKind, "yesno" | "text">; label: string; button: string; action: FormAction }) {
  const [state, formAction, pending] = useActionState(action, initial);
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-40 flex-1 flex-col gap-1 text-sm">
        <span className="text-xs text-muted-foreground">{label}</span>
        <ValueInput kind={kind} defaultValue="" label={label} />
      </label>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Saving…" : button}
      </Button>
      <div className="basis-full">
        <Problem state={state} />
      </div>
    </form>
  );
}
