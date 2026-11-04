"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { StartState } from "./actions";

type Props = { action: (previous: StartState, formData: FormData) => Promise<StartState> };

export function StartForm({ action }: Props) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as StartState);

  return (
    <form action={formAction} className="flex w-full max-w-xl flex-col gap-3 text-left">
      <label htmlFor="message" className="text-sm font-medium">
        Describe the custom order you have in mind
      </label>
      <textarea
        id="message"
        name="message"
        required
        maxLength={4000}
        rows={5}
        placeholder="For example: 20 welcome boxes with notebooks, no food, our logo, under $40 per box"
        className="w-full rounded-lg border border-border bg-background p-3 text-sm"
      />
      <p className="text-xs text-muted-foreground">
        This is a sandbox demo with synthetic data. Don&apos;t enter real personal or payment details: your message is read by an AI model.
      </p>
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Reading your request…" : "Start my request"}
      </Button>
      {state.status === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
