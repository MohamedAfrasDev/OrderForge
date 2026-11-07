import { Conversation } from "@/components/conversation";
import { CalculatedNote } from "@/components/provenance-note";
import { PROVENANCE_LABELS, provenanceOfField } from "@/domain/journey";
import { cents, format } from "@/lib/money";
import type { CustomerSpecField, CustomerSpecView } from "@/services/intake/read";
import { chooseAction, editFieldAction, handOffAction, quickReplyAction, retryTurnAction, sendMessageAction } from "./intake-actions";
import { ActionButton, AnswerBox, Chip, ChooseButton, MessageForm, OrderLine, type InputKind } from "./intake-forms";

const BLOCKER_WORDS: Record<string, string> = {
  INSUFFICIENT_STOCK: "not enough of one product is in stock",
  OVER_BUDGET: "it is over your budget",
  FOOD_NOT_ALLOWED: "it contains food",
  LOGO_NOT_COVERED: "the logo is not covered",
  UNSUPPORTED_DATE: "the pickup date is too early",
  BELOW_MIN_QUANTITY: "the quantity is below the minimum",
};

const KIND: Record<string, InputKind> = {
  boxCount: "number",
  noFood: "yesno",
  logoRequired: "yesno",
  maxPricePerBoxMinor: "money",
  requestedPickupDate: "date",
  preferences: "text",
};

/** What a line says, in words, or null when nothing is known (the line then reads "Tell us"). */
function display(f: CustomerSpecField): string | null {
  const v = f.value;
  if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return null;
  switch (f.name) {
    case "maxPricePerBoxMinor":
      return typeof v === "number" ? format(cents(v)) : null;
    case "noFood":
    case "logoRequired":
      return v === true ? "Yes" : "No";
    case "preferences":
      return Array.isArray(v) ? v.join(", ") : null;
    default:
      return String(v);
  }
}

/** How sure we are and where it came from, in the customer's words. */
function note(f: CustomerSpecField): string {
  if (display(f) === null) return "";
  if (f.status === "conflicted") return "Which one is right?";
  if (f.status === "needs_confirmation") return "Is this right?";
  const where = provenanceOfField(f);
  return where ? PROVENANCE_LABELS[where].label : "";
}

/** The value to start the editor with, in the form its box takes (dollars for money, yes or no for a choice). */
function editorValue(f: CustomerSpecField): string {
  const v = f.value;
  if (v === null || v === undefined) return "";
  if (f.name === "maxPricePerBoxMinor" && typeof v === "number") return (v / 100).toFixed(2);
  if (f.name === "noFood" || f.name === "logoRequired") return v === true ? "yes" : "no";
  return Array.isArray(v) ? v.join(", ") : String(v);
}

type Props = {
  token: string;
  spec: CustomerSpecView | null;
  status: string;
  /** A customer message that nobody has answered (the assistant failed): offers a retry. */
  unanswered: boolean;
  messages: Array<{ id: string; role: string; body: string; createdAt: string }>;
  shopName: string;
};

const ANSWER_TEXT: Record<"number" | "money" | "date", { label: string; button: string }> = {
  number: { label: "Or type a number", button: "Use this number" },
  money: { label: "Or type a budget in dollars", button: "Use this budget" },
  date: { label: "Or pick a date", button: "Use this date" },
};

/**
 * The conversation and what builds beside it: the order so far (every line tappable), the one question the assistant is waiting on
 * with tappable answers, the boxes it suggests with code's prices, the box to write in, and, after a failure, retry and handoff.
 * Side by side on a desktop; on a phone the order so far sits between the conversation and the box to write in. Plain text throughout.
 */
export function IntakePanels({ token, spec, status, unanswered, messages, shopName }: Props) {
  const withShop = status === "REVIEW_REQUIRED";
  const names = spec?.productNames ?? {};
  const name = (sku: string) => names[sku] ?? "an item";
  const proposal = spec?.proposal ?? null;
  const chosen = proposal?.chosen ?? null;
  const canChoose = status === "CONFIGURING" && !chosen;
  const open = spec?.question && status === "CLARIFYING" && spec.questionField && spec.quick ? { field: spec.questionField, quick: spec.quick } : null;
  /** What is in a box, item by item with its price; the swapped-in item is marked. Falls back to the names alone if the catalog could not be read. */
  const items = (selections: Record<string, string>, swappedSlot?: string) => {
    const slots = Object.keys(spec?.slots ?? {}).filter((slot) => selections[slot] !== undefined);
    if (slots.length === 0) return <p className="text-sm">{Object.values(selections).map(name).join(", ")}</p>;
    return (
      <ul className="flex flex-col text-sm">
        {slots.map((slot) => {
          const sku = selections[slot]!;
          const quantity = spec!.slots[slot]!.quantity;
          const price = spec!.productPrices[sku];
          return (
            <li key={slot} className="flex justify-between gap-3 border-t border-border py-1 first:border-t-0">
              <span>
                {name(sku)}
                {quantity > 1 ? ` × ${quantity}` : ""}
                {slot === swappedSlot ? " (swapped in)" : ""}
              </span>
              <span className="tabular-nums">{price === undefined ? "" : format(cents(price * quantity))}</span>
            </li>
          );
        })}
      </ul>
    );
  };
  const openField = open?.field ?? null;
  const quick = open?.quick ?? null;

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] md:items-start">
      <div className="flex min-w-0 flex-col gap-4 md:col-start-1 md:row-start-1">
        {withShop ? (
          <p role="status" className="rounded-lg border border-border bg-muted p-3 text-sm">
            The shop can see this conversation and your order so far.
          </p>
        ) : null}

        <Conversation messages={messages} shopName={shopName} />

        {spec?.question && openField && quick ? (
          <section aria-label="Open question" className="flex flex-col gap-3 rounded-lg border border-border bg-muted p-4">
            <div>
              <p className="text-xs text-muted-foreground">The assistant needs one more answer</p>
              <p className="mt-1 text-sm font-medium">{spec.question}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {quick.choices.map((choice, index) => (
                <Chip key={choice.label} label={choice.label} action={quickReplyAction.bind(null, token, openField, index)} />
              ))}
            </div>
            {quick.kind === "number" || quick.kind === "money" || quick.kind === "date" ? (
              <AnswerBox kind={quick.kind} label={ANSWER_TEXT[quick.kind].label} button={ANSWER_TEXT[quick.kind].button} action={editFieldAction.bind(null, token, openField)} />
            ) : null}
          </section>
        ) : null}

        {proposal ? (
          <section aria-label="Proposals" className="flex flex-col gap-3">
            {proposal.status === "VALID" && proposal.priced ? (
              <article className="flex flex-col gap-2 rounded-lg border border-border p-4">
                <h2 className="text-lg font-medium">A box for you</h2>
                {items(proposal.selections)}
                <p className="text-2xl font-semibold tabular-nums">
                  {format(cents(proposal.priced.perBoxMinor))} per box · {format(cents(proposal.priced.totalMinor))} for {proposal.priced.boxCount} boxes
                </p>
                <CalculatedNote />
                {canChoose ? <ChooseButton action={chooseAction.bind(null, token)} optionKey="proposal" /> : null}
              </article>
            ) : (
              <>
                <h2 className="text-lg font-medium">Boxes that work</h2>
                <div role="note" className="flex flex-col gap-1 rounded-lg border-2 border-foreground p-3">
                  <p className="text-sm font-semibold">A stock limit changes your box</p>
                  <p className="text-sm">
                    We can&apos;t make the first box we picked
                    {proposal.blockers.length > 0 ? ` (${[...new Set(proposal.blockers.map((b) => BLOCKER_WORDS[b] ?? "it is not available as asked"))].join("; ")})` : ""}.
                  </p>
                </div>
                {proposal.alternatives.length === 0 ? <p className="text-sm">No other box fits. You can change something in your order, or ask the shop to take over.</p> : null}
                {proposal.alternatives.map((a) => (
                  <article key={a.key} className="flex flex-col gap-2 rounded-lg border border-border p-4">
                    <p className="text-sm font-medium">
                      Replace {name(a.fromSku)} with {name(a.toSku)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      One change: {name(a.fromSku)}
                      {spec?.productPrices[a.fromSku] === undefined ? "" : ` (${format(cents(spec.productPrices[a.fromSku]!))})`} becomes {name(a.toSku)}
                      {spec?.productPrices[a.toSku] === undefined ? "" : ` (${format(cents(spec.productPrices[a.toSku]!))})`}. The price below already includes it.
                    </p>
                    <p className="text-2xl font-semibold tabular-nums">
                      {format(cents(a.perBoxMinor))} per box · {format(cents(a.totalMinor))} in total
                    </p>
                    <CalculatedNote />
                    {items({ ...proposal.selections, [a.slotId]: a.toSku }, a.slotId)}
                    {a.explanation ? <p className="text-sm text-muted-foreground">{a.explanation}</p> : null}
                    {canChoose ? <ChooseButton action={chooseAction.bind(null, token)} optionKey={a.key} /> : null}
                  </article>
                ))}
              </>
            )}
          </section>
        ) : null}

        {unanswered && !withShop ? (
          <section aria-label="The assistant could not answer" className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <p className="text-sm">The assistant has not answered your last message. It is kept, and nothing has been decided.</p>
            <div className="flex flex-wrap gap-2">
              <ActionButton action={retryTurnAction.bind(null, token)} label="Try again" pendingLabel="Trying again…" variant="default" />
              <ActionButton action={handOffAction.bind(null, token)} label="Ask the shop to take over" pendingLabel="Asking…" />
            </div>
          </section>
        ) : null}
      </div>

      <aside className="min-w-0 md:sticky md:top-4 md:col-start-2 md:row-span-2 md:row-start-1">
        <section aria-label="Your order so far" className="flex flex-col gap-1 rounded-lg border border-border p-4">
          <h2 className="text-lg font-medium">Your order so far</h2>
          {spec ? (
            <>
              <ul className="flex flex-col">
                {spec.fields.map((f) =>
                  withShop ? (
                    <li key={f.name} className="flex items-start justify-between gap-3 border-t border-border py-2 text-sm first:border-t-0">
                      <span className="font-medium">{f.label}</span>
                      <span>{display(f) ?? "Not given"}</span>
                    </li>
                  ) : (
                    <OrderLine
                      key={`${f.name}|${display(f)}|${note(f)}`}
                      label={f.label}
                      display={display(f)}
                      note={note(f)}
                      kind={KIND[f.name] ?? "text"}
                      editorValue={editorValue(f)}
                      asked={f.name === openField}
                      action={editFieldAction.bind(null, token, f.name)}
                    />
                  ),
                )}
              </ul>
              {!withShop ? <p className="text-xs text-muted-foreground">Tap any line to change it.</p> : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">It fills in as we read your messages.</p>
          )}
        </section>
      </aside>

      <div className="flex min-w-0 flex-col gap-3 md:col-start-1 md:row-start-2">
        <MessageForm action={sendMessageAction.bind(null, token)} />
        {!withShop && !unanswered && status !== "QUOTE_READY" ? <ActionButton action={handOffAction.bind(null, token)} label="Ask the shop to take over" pendingLabel="Asking…" /> : null}
      </div>
    </div>
  );
}
