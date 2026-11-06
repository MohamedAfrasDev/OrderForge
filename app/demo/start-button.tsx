"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/** The submit button of a prepared request. The assistant takes a moment, so the button says it is working and cannot be pressed twice. */
export function StartButton({ label, working }: { label: string; working: string }) {
  const { pending } = useFormStatus();
  return (
    <>
      <Button type="submit" size="lg" disabled={pending} aria-describedby={pending ? "demo-working" : undefined}>
        {pending ? "Starting…" : label}
      </Button>
      {pending ? (
        <p id="demo-working" role="status" className="text-sm text-muted-foreground">
          {working}
        </p>
      ) : null}
    </>
  );
}
