"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { replyAction, type ReplyState } from "./actions";

const idle: ReplyState = { status: "idle" };

export function ReplyForm({ inquiryId }: { inquiryId: string }) {
  const [state, action, pending] = useActionState(replyAction, idle);
  return (
    <form action={action} className="flex flex-col gap-2" key={state.status === "done" ? "sent" : "typing"}>
      <input type="hidden" name="inquiryId" value={inquiryId} />
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Reply to the customer</span>
        <textarea name="body" required maxLength={4000} rows={3} className="w-full rounded-lg border border-border bg-background p-2.5 text-sm" />
      </label>
      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send reply"}
      </Button>
      {state.status === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
