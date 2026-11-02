"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { reconcileNowAction, spikeAction, type ReconcileState, type SpikeState } from "./actions";

const outcomeStyle = {
  ok: "text-green-700 dark:text-green-400",
  failed: "text-destructive",
  unknown: "text-amber-700 dark:text-amber-400",
} as const;

export function SpikeControls({ isFake, returnedOrderId }: { isFake: boolean; returnedOrderId?: string }) {
  const [state, action, pending] = useActionState<SpikeState, FormData>(
    spikeAction,
    returnedOrderId
      ? { orderId: returnedOrderId, steps: [], message: `Back from PayPal. Order ${returnedOrderId} is ready to authorize.` }
      : null,
  );
  const [reconcile, reconcileAction, reconciling] = useActionState<ReconcileState>(reconcileNowAction, null);
  const orderId = state?.orderId;

  return (
    <div className="flex w-full flex-col gap-8">
      <section className="flex flex-col gap-3" aria-label="PayPal spike">
        <h2 className="text-lg font-semibold">1. Create an order</h2>
        <form action={action}>
          <input type="hidden" name="intent" value="create" />
          <Button type="submit" disabled={pending}>
            Create sandbox order
          </Button>
        </form>

        {orderId ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <p>
              Order <code data-testid="order-id">{orderId}</code>
            </p>
            {state?.approveUrl ? (
              <a href={state.approveUrl} target="_blank" rel="noopener noreferrer" className="underline">
                Approve in the PayPal sandbox (use a sandbox buyer account)
              </a>
            ) : null}

            <form action={action} className="flex flex-wrap gap-3">
              <input type="hidden" name="orderId" value={orderId} />
              {isFake ? (
                <Button type="submit" name="intent" value="approve-fake" variant="outline" disabled={pending}>
                  Simulate buyer approval (fake PayPal only)
                </Button>
              ) : null}
              <Button type="submit" name="intent" value="capture" disabled={pending}>
                Authorize, then capture
              </Button>
              <Button type="submit" name="intent" value="void" variant="outline" disabled={pending}>
                Authorize, then void
              </Button>
            </form>
          </div>
        ) : null}

        {state?.message ? <p role="status">{state.message}</p> : null}

        {state && state.steps.length > 0 ? (
          <ol aria-label="Steps" className="flex flex-col gap-1 text-sm">
            {state.steps.map((s, i) => (
              <li key={`${s.step}-${i}`}>
                <span className={outcomeStyle[s.outcome]}>[{s.outcome}]</span> <strong>{s.step}</strong>: {s.detail}{" "}
                <span className="text-muted-foreground">({s.evidence})</span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <section className="flex flex-col gap-3" aria-label="Reconcile">
        <h2 className="text-lg font-semibold">2. Reconcile</h2>
        <form action={reconcileAction}>
          <Button type="submit" variant="outline" disabled={reconciling}>
            Run reconcile now
          </Button>
        </form>
        {reconcile ? <p role="status">{reconcile.message}</p> : null}
      </section>
    </div>
  );
}
