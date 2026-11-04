"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { IntakeState } from "./intake-actions";

type FormAction = (previous: IntakeState, formData: FormData) => Promise<IntakeState>;
type ButtonAction = () => Promise<IntakeState>;

const initial: IntakeState = { status: "idle" };

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
    <form action={formAction} className="flex flex-col gap-2">
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
      <p className="text-xs text-muted-foreground">Synthetic data only: please do not enter real personal or payment details. Your message is read by an AI model.</p>
      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send"}
      </Button>
      <Problem state={state} />
    </form>
  );
}

/** "Use this one": sends which option, never an amount. */
export function ChooseButton({ action, optionKey }: { action: FormAction; optionKey: string }) {
  const [state, formAction, pending] = useActionState(action, initial);
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="key" value={optionKey} />
      <Button type="submit" disabled={pending || state.status === "done"}>
        {pending ? "Preparing your quote…" : "Use this one"}
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

export type EditValues = { boxCount: string; noFood: string; logoRequired: string; budget: string; requestedPickupDate: string; preferences: string };

export function SpecEditor({ action, values }: { action: FormAction; values: EditValues }) {
  const [state, formAction, pending] = useActionState(action, initial);
  const input = "w-full rounded-md border border-border bg-background p-2 text-sm";
  const choice = (name: "noFood" | "logoRequired", label: string) => (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <select name={name} defaultValue={values[name]} className={input}>
        <option value="">Not specified</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  );
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        Number of boxes
        <input name="boxCount" defaultValue={values.boxCount} inputMode="numeric" className={input} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Budget per box (USD)
        <input name="budget" defaultValue={values.budget} inputMode="decimal" className={input} />
      </label>
      {choice("noFood", "No food")}
      {choice("logoRequired", "Company logo")}
      <label className="flex flex-col gap-1 text-sm">
        Pickup date (YYYY-MM-DD)
        <input name="requestedPickupDate" defaultValue={values.requestedPickupDate} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Preferences (comma separated)
        <input name="preferences" defaultValue={values.preferences} className={input} />
      </label>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save my changes"}
        </Button>
        <Problem state={state} />
      </div>
    </form>
  );
}
