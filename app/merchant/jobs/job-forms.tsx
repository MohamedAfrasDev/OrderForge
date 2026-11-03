"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { moveJobAction, type MoveState } from "./actions";

const idle: MoveState = { status: "idle" };
const inputClass = "w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm";

export type Move = { to: string; label: string };

/** The moves open to this job right now, with a note box (needed for a hold). The buttons disable while a request runs. */
export function JobForms({ jobId, moves }: { jobId: string; moves: Move[] }) {
  const [state, action, pending] = useActionState(moveJobAction, idle);
  if (moves.length === 0) return <p className="text-sm text-muted-foreground">Nothing more to do on this job.</p>;

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="jobId" value={jobId} />
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Note (required for a hold, otherwise optional)</span>
        <input name="note" type="text" maxLength={500} className={inputClass} />
      </label>
      <div className="flex flex-wrap gap-2">
        {moves.map((m) => (
          <Button key={m.to} type="submit" name="to" value={m.to} variant={m.to === "ON_HOLD" ? "outline" : "default"} disabled={pending}>
            {m.label}
          </Button>
        ))}
      </div>
      {state.status !== "idle" ? (
        <p role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "text-sm text-destructive" : "text-sm"}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
