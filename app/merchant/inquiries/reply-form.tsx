"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { replyAction, type ReplyState } from "./actions";

const idle: ReplyState = { status: "idle" };

// Starting points the shop can change before sending. They only fill the box: nothing is sent until the shop sends it, and none promises a time.
export const PHRASES = [
  { label: "Thanks, looking now", text: "Thanks for your request. I'm looking at it now." },
  { label: "Ask for number and date", text: "Could you tell me how many boxes you need, and by when?" },
  { label: "Yes, price to follow", text: "Yes, we can do that. I'll send you a price here in this conversation." },
] as const;

/** The text box with its starting phrases. Its text lives here, so a sent reply (which remounts the form) starts the next one empty. */
function ReplyFields() {
  const [text, setText] = useState("");
  return (
    <>
      <div role="group" aria-label="Starting phrases" className="flex flex-wrap gap-2">
        {PHRASES.map((phrase) => (
          <Button key={phrase.label} type="button" variant="outline" size="sm" onClick={() => setText((now) => (now.trim() ? now.trimEnd() + "\n" + phrase.text : phrase.text))}>
            {phrase.label}
          </Button>
        ))}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Reply to the customer</span>
        <textarea name="body" required maxLength={4000} rows={3} value={text} onChange={(event) => setText(event.target.value)} className="w-full rounded-lg border border-border bg-background p-2.5 text-sm" />
      </label>
    </>
  );
}

export function ReplyForm({ inquiryId }: { inquiryId: string }) {
  const [state, action, pending] = useActionState(replyAction, idle);
  return (
    <form action={action} className="flex flex-col gap-2" key={state.status === "done" ? "sent" : "typing"}>
      <input type="hidden" name="inquiryId" value={inquiryId} />
      <ReplyFields />
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
