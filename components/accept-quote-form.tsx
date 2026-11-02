"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { AcceptState } from "@/app/o/[token]/actions";

type Props = {
  /** The accept action with the customer's link token already bound on the server. */
  action: (previous: AcceptState, formData: FormData) => Promise<AcceptState>;
  quoteId: string;
  hash: string;
};

export function AcceptQuoteForm({ action, quoteId, hash }: Props) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as AcceptState);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="quoteId" value={quoteId} />
      <input type="hidden" name="hash" value={hash} />
      <Button type="submit" size="lg" disabled={pending || state.status === "done"}>
        {pending ? "Accepting…" : "Accept this exact quote"}
      </Button>
      {state.status === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
