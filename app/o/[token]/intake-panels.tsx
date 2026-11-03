import { cents, format } from "@/lib/money";
import type { CustomerSpecField, CustomerSpecView } from "@/services/intake/read";
import { chooseAction, editSpecAction, handOffAction, retryTurnAction, sendMessageAction } from "./intake-actions";
import { ActionButton, ChooseButton, MessageForm, SpecEditor, type EditValues } from "./intake-forms";

const STATUS_WORDS: Record<string, string> = {
  confirmed: "confirmed",
  needs_confirmation: "needs your confirmation",
  conflicted: "conflicting: please say which is right",
  unknown: "not specified",
};

const SOURCE_WORDS = { message: "from your message", edit: "your own edit", none: "" } as const;

const BLOCKER_WORDS: Record<string, string> = {
  INSUFFICIENT_STOCK: "not enough of one product is in stock",
  OVER_BUDGET: "it is over your budget",
  FOOD_NOT_ALLOWED: "it contains food",
  LOGO_NOT_COVERED: "the logo is not covered",
  UNSUPPORTED_DATE: "the pickup date is too early",
  BELOW_MIN_QUANTITY: "the quantity is below the minimum",
};

function show(field: CustomerSpecField): string {
  const v = field.value;
  if (v === null || v === undefined) return "Not specified";
  switch (field.name) {
    case "maxPricePerBoxMinor":
      return typeof v === "number" ? format(cents(v)) : "Not specified";
    case "noFood":
    case "logoRequired":
      return v === true ? "Yes" : "No";
    case "preferences":
      return Array.isArray(v) ? v.join(", ") : "Not specified";
    default:
      return String(v);
  }
}

function editValues(fields: CustomerSpecField[]): EditValues {
  const get = (name: string) => fields.find((f) => f.name === name)?.value ?? null;
  const yn = (v: unknown) => (v === true ? "yes" : v === false ? "no" : "");
  const budget = get("maxPricePerBoxMinor");
  return {
    boxCount: get("boxCount") === null ? "" : String(get("boxCount")),
    noFood: yn(get("noFood")),
    logoRequired: yn(get("logoRequired")),
    budget: typeof budget === "number" ? (budget / 100).toFixed(2) : "",
    requestedPickupDate: get("requestedPickupDate") === null ? "" : String(get("requestedPickupDate")),
    preferences: Array.isArray(get("preferences")) ? (get("preferences") as string[]).join(", ") : "",
  };
}

type Props = {
  token: string;
  spec: CustomerSpecView | null;
  status: string;
  /** A customer message that nobody has answered (the assistant failed): offers a retry. */
  unanswered: boolean;
};

/**
 * The conversation tools of the order room: the specification the assistant has recorded (every field with how sure we are and
 * where it came from, editable), the one question it is waiting on, its proposals with code's prices, the composer, and, after a
 * failure, retry and handoff. Everything is rendered as plain text.
 */
export function IntakePanels({ token, spec, status, unanswered }: Props) {
  const withMerchant = status === "REVIEW_REQUIRED";
  const names = spec?.productNames ?? {};
  const name = (sku: string) => names[sku] ?? "an item";
  const chosen = spec?.proposal?.chosen ?? null;
  const canChoose = status === "CONFIGURING" && !chosen;

  return (
    <>
      {withMerchant ? (
        <p role="status" className="rounded-lg border border-border bg-muted p-3 text-sm">
          The merchant has your request and will reply here. They can see this conversation and your requirements.
        </p>
      ) : null}

      {spec ? (
        <section aria-label="Your specification" className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <h2 className="text-lg font-medium">Your specification</h2>
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            {spec.fields.map((f) => (
              <div key={f.name} className="contents">
                <dt className="font-medium">{f.label}</dt>
                <dd>
                  <span>{show(f)}</span>
                  {f.status === "unknown" ? null : (
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      ({STATUS_WORDS[f.status]}
                      {f.source ? `, ${SOURCE_WORDS[f.source]}` : ""})
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {!withMerchant ? (
            <details>
              <summary className="cursor-pointer text-sm font-medium">Change something</summary>
              <div className="mt-3">
                <SpecEditor action={editSpecAction.bind(null, token)} values={editValues(spec.fields)} />
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

      {spec?.question && status === "CLARIFYING" ? (
        <section aria-label="Open question" className="rounded-lg border border-border bg-muted p-4">
          <p className="text-xs text-muted-foreground">The assistant needs one more answer</p>
          <p className="mt-1 text-sm font-medium">{spec.question}</p>
        </section>
      ) : null}

      {spec?.proposal ? (
        <section aria-label="Proposals" className="flex flex-col gap-3">
          {spec.proposal.status === "VALID" && spec.proposal.priced ? (
            <article className="flex flex-col gap-2 rounded-lg border border-border p-4">
              <h2 className="text-lg font-medium">Proposed box</h2>
              <p className="text-sm">{Object.values(spec.proposal.selections).map(name).join(", ")}</p>
              <p className="text-sm font-medium">
                {format(cents(spec.proposal.priced.perBoxMinor))} per box · {format(cents(spec.proposal.priced.totalMinor))} for {spec.proposal.priced.boxCount} boxes
              </p>
              {canChoose ? <ChooseButton action={chooseAction.bind(null, token)} optionKey="proposal" /> : null}
            </article>
          ) : (
            <>
              <h2 className="text-lg font-medium">Options that work</h2>
              <p className="text-sm text-muted-foreground">
                The box first chosen cannot be made as asked
                {spec.proposal.blockers.length > 0 ? ` (${[...new Set(spec.proposal.blockers.map((b) => BLOCKER_WORDS[b] ?? "it is not available as asked"))].join("; ")})` : ""}.
              </p>
              {spec.proposal.alternatives.length === 0 ? <p className="text-sm">No alternative fits. You can change a requirement above, or ask the merchant to take over.</p> : null}
              {spec.proposal.alternatives.map((a) => (
                <article key={a.key} className="flex flex-col gap-2 rounded-lg border border-border p-4">
                  <p className="text-sm font-medium">
                    Replace {name(a.fromSku)} with {name(a.toSku)}
                  </p>
                  <p className="text-sm">
                    {format(cents(a.perBoxMinor))} per box · {format(cents(a.totalMinor))} in total
                  </p>
                  {a.explanation ? <p className="text-sm text-muted-foreground">{a.explanation}</p> : null}
                  {canChoose ? <ChooseButton action={chooseAction.bind(null, token)} optionKey={a.key} /> : null}
                </article>
              ))}
            </>
          )}
        </section>
      ) : null}

      {unanswered && !withMerchant ? (
        <section aria-label="The assistant could not answer" className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <p className="text-sm">The assistant has not answered your last message. It is kept, and nothing has been decided.</p>
          <div className="flex flex-wrap gap-2">
            <ActionButton action={retryTurnAction.bind(null, token)} label="Try again" pendingLabel="Trying again…" variant="default" />
            <ActionButton action={handOffAction.bind(null, token)} label="Ask the merchant to take over" pendingLabel="Asking…" />
          </div>
        </section>
      ) : null}

      <MessageForm action={sendMessageAction.bind(null, token)} />

      {!withMerchant && !unanswered && status !== "QUOTE_READY" ? (
        <ActionButton action={handOffAction.bind(null, token)} label="Ask the merchant to take over" pendingLabel="Asking…" />
      ) : null}
    </>
  );
}
