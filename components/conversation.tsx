type Message = { id: string; role: string; body: string; createdAt: string };

const formatTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** The one-line message the app posts when the customer changes their order; it reads as a quiet note, not as something they said. */
export const isEditNote = (message: Pick<Message, "role" | "body">) => message.role === "customer" && /^I updated my requirements \(change \d+\)\.$/.test(message.body);

function nameOf(role: string, shopName: string): string {
  switch (role) {
    case "customer":
      return "You";
    case "assistant":
      return "Assistant";
    case "merchant":
      return shopName;
    default:
      return "Note";
  }
}

/** The conversation as people read it: who spoke in plain words, their own messages set apart, everything as plain text. */
export function Conversation({ messages, shopName }: { messages: Message[]; shopName: string }) {
  return (
    <section aria-label="Conversation" className="flex flex-col gap-3">
      {messages.length === 0 ? (
        <p className="text-muted-foreground">No messages yet.</p>
      ) : (
        messages.map((m) =>
          isEditNote(m) ? (
            <p key={m.id} className="text-center text-xs italic text-muted-foreground">
              You changed your order · {formatTime(m.createdAt)}
            </p>
          ) : (
            <article key={m.id} className={`rounded-lg border p-3 ${m.role === "customer" ? "border-border bg-muted/40" : "border-border"}`}>
              <p className="text-xs text-muted-foreground">
                {nameOf(m.role, shopName)} · {formatTime(m.createdAt)}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{m.body}</p>
            </article>
          ),
        )
      )}
    </section>
  );
}
