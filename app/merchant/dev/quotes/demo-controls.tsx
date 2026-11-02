"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { createDemoQuoteAction, type DemoState } from "./actions";

export function DemoControls() {
  const [state, action, pending] = useActionState(createDemoQuoteAction, null as DemoState);

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="held" disabled={pending}>
          Create a draft that needs my decision
        </Button>
        <Button type="submit" name="intent" value="published" variant="outline" disabled={pending}>
          Create a published quote
        </Button>
      </div>
      {state ? (
        <p role="status" className="text-sm">
          {state.message}
          {state.customerPath ? (
            <>
              {" "}
              <a href={state.customerPath} className="underline">
                Open the customer link
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
