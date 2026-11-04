"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { QuoteBuilderView } from "@/services/intake/merchant-quote";
import { buildQuoteAction, type BuildState } from "./actions";

const idle: BuildState = { status: "idle" };
const money = (minor: number) => `$${(minor / 100).toFixed(2)}`;

/**
 * The form to build a price: how many boxes, one product for each part of the box, and whether the two fixed notes apply. There is no price
 * field; the price is worked out by the catalog engine when the form is sent, and the customer is told.
 */
export function QuoteForm({ view, notes }: { view: QuoteBuilderView; notes: { artwork: string; productionSlot: string } }) {
  const [state, action, pending] = useActionState(buildQuoteAction, idle);

  if (state.status === "done") {
    return (
      <div role="status" aria-label="Price sent" className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <h2 className="text-lg font-semibold">Price sent</h2>
        <p className="text-sm">
          {state.total} for {state.boxes} boxes ({state.perBox} per box). The customer has been told and can accept it in their order page.
        </p>
        <Link href="/merchant/inquiries" className={cn(buttonVariants(), "self-start")}>
          Back to requests
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="inquiryId" value={view.inquiryId} />

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Number of boxes</span>
        <input name="quantity" inputMode="numeric" pattern="[0-9]*" required defaultValue={view.quantity ?? ""} className="w-32 rounded-lg border border-border bg-background p-2.5 text-sm" />
      </label>

      {view.slots.map((slot) => (
        <fieldset key={slot.id} className="flex flex-col gap-2">
          <legend className="text-sm font-medium">
            {slot.label} <span className="font-normal text-muted-foreground">({slot.quantity} in each box)</span>
          </legend>
          {slot.products.length === 0 ? <p className="text-sm text-destructive">No product is on sale for this part of the box.</p> : null}
          {slot.products.map((p) => (
            <label key={p.sku} className="flex items-start gap-2 rounded-md border border-border p-2 text-sm">
              <input type="radio" name={`slot-${slot.id}`} value={p.sku} required className="mt-1" />
              <span className="flex flex-col">
                <span>{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  {money(p.unitPriceMinor)} each · {p.available} available
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ))}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Notes for the customer</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="artwork" className="mt-1" />
          <span>{notes.artwork}</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="productionSlot" className="mt-1" />
          <span>{notes.productionSlot}</span>
        </label>
      </fieldset>

      <p className="text-sm text-muted-foreground">The price is worked out from your catalog when you send it. You cannot type a price or a discount here.</p>

      {state.status === "error" ? (
        <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
          <p>{state.message}</p>
          {state.blockers ? (
            <ul className="list-disc pl-5">
              {state.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Sending…" : "Send price to the customer"}
      </Button>
    </form>
  );
}
