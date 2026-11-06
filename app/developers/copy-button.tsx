"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Copies a block of text. If the browser refuses, the block stays selectable (select-all) so nothing depends on this button. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 2000);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : "Copy"}
    </Button>
  );
}
