"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { cents, format } from "@/lib/money";
import { acceptOrderAction, declineOrderAction, type DecisionState } from "./actions";

const idle: DecisionState = { status: "idle" };

function Message({ state }: { state: DecisionState }) {
  if (state.status === "idle") return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "text-sm text-destructive" : "text-sm"}>
      {state.message}
    </p>
  );
}

const inputClass = "w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm";

type Condition = { code: string; text: string };

/** Accept (confirming each listed condition) or decline (with a reason), for one authorized order. The buttons disable while a request is running. */
export function DecisionForms({ purchaseId, conditions, totalMinor }: { purchaseId: string; conditions: Condition[]; totalMinor: number }) {
  const amount = format(cents(totalMinor));
  const [acceptState, accept, accepting] = useActionState(acceptOrderAction, idle);
  const [declineState, decline, declining] = useActionState(declineOrderAction, idle);
  const busy = accepting || declining;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <form action={accept} className="flex flex-col gap-2 rounded-lg border-2 border-foreground p-3">
        <h4 className="text-sm font-semibold">Accept: take the payment</h4>
        <p className="text-sm">PayPal charges the {amount} it is holding, once, and the order moves on to preparation.</p>
        <input type="hidden" name="purchaseId" value={purchaseId} />
        {conditions.length > 0 ? (
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">Confirm before accepting</legend>
            {conditions.map((c) => (
              <label key={c.code} className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="confirm" value={c.code} className="mt-1" />
                <span>{c.text}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <Button type="submit" disabled={busy}>
          {accepting ? "Accepting…" : "Accept and take payment"}
        </Button>
        <Message state={acceptState} />
      </form>

      <form action={decline} className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <h4 className="text-sm font-semibold">Decline: release the hold</h4>
        <p className="text-sm">The {amount} hold is released, the customer is not charged and the stock is freed.</p>
        <input type="hidden" name="purchaseId" value={purchaseId} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Reason for declining</span>
          <input name="reason" type="text" maxLength={500} className={inputClass} />
        </label>
        <Button type="submit" variant="outline" disabled={busy}>
          {declining ? "Declining…" : "Decline and cancel the authorization"}
        </Button>
        <Message state={declineState} />
      </form>
    </div>
  );
}
