"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { publishDraftAction, withdrawDraftAction, type ReviewState } from "./actions";

const idle: ReviewState = { status: "idle" };

function Message({ state }: { state: ReviewState }) {
  if (state.status === "idle") return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "text-sm text-destructive" : "text-sm"}>
      {state.message}
    </p>
  );
}

const inputClass = "w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm";

/** Publish (with the merchant's own wording when something needs a decision) and withdraw, for one draft. */
export function ReviewForms({ quoteId, needsDecision }: { quoteId: string; needsDecision: boolean }) {
  const [publishState, publishAction, publishing] = useActionState(publishDraftAction, idle);
  const [withdrawState, withdrawAction, withdrawing] = useActionState(withdrawDraftAction, idle);

  return (
    <div className="flex flex-col gap-4">
      <form action={publishAction} className="flex flex-col gap-2">
        <input type="hidden" name="quoteId" value={quoteId} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{needsDecision ? "Your wording for the customer (required)" : "Your wording for the customer (optional)"}</span>
          <textarea name="wording" rows={2} maxLength={500} required={needsDecision} className={inputClass} />
        </label>
        <Button type="submit" disabled={publishing}>
          {publishing ? "Publishing…" : "Approve and publish"}
        </Button>
        <Message state={publishState} />
      </form>

      <form action={withdrawAction} className="flex flex-col gap-2">
        <input type="hidden" name="quoteId" value={quoteId} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Reason for withdrawing</span>
          <input name="reason" type="text" maxLength={500} className={inputClass} />
        </label>
        <Button type="submit" variant="outline" disabled={withdrawing}>
          {withdrawing ? "Withdrawing…" : "Withdraw quote"}
        </Button>
        <Message state={withdrawState} />
      </form>
    </div>
  );
}
