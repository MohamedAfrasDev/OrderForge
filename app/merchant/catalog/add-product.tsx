"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { addProductAction, type AddState } from "./actions";

const idle: AddState = { status: "idle" };
const field = "w-full rounded-lg border border-border bg-background p-2.5 text-sm";

/** Adds a product: what it is, its price in dollars and cents, how many there are, and which parts of the box it can go in. */
export function AddProduct({ slots }: { slots: Array<{ id: string; label: string }> }) {
  const [state, action, pending] = useActionState(addProductAction, idle);
  return (
    // A fresh form after each product that was added, so the next one starts empty.
    <form action={action} key={state.status === "done" ? `done-${state.name}` : "open"} className="flex flex-col gap-4" aria-label="Add a product">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Name</span>
          <input name="name" required maxLength={120} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Category</span>
          <input name="category" required maxLength={64} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Price (dollars)</span>
          <input name="price" required inputMode="decimal" placeholder="12.50" className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">How many you have</span>
          <input name="onHand" required inputMode="numeric" placeholder="40" className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Code</span>
          <input name="sku" required maxLength={64} placeholder="MUG-BLUE" className={field} />
          <span className="text-xs text-muted-foreground">Letters, numbers, dots, dashes. It cannot be changed later.</span>
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" name="isFood" />
          <span>This is food</span>
        </label>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Goes in these parts of the box</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {slots.map((slot) => (
            <label key={slot.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="slot" value={slot.id} />
              <span>{slot.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Adding…" : "Add product"}
      </Button>
      {state.status === "error" ? (
        <p role="alert" data-testid="add-product-message" className="text-sm text-destructive">
          {state.message}
        </p>
      ) : null}
      {state.status === "done" ? (
        <p role="status" aria-label="Product added" className="text-sm">
          {state.name} was added. It is on sale now, in the parts of the box you chose.
        </p>
      ) : null}
    </form>
  );
}
