import type { AcceptState } from "@/app/o/[token]/actions";
import { AcceptQuoteForm } from "@/components/accept-quote-form";
import { cents, format } from "@/lib/money";
import type { CustomerQuoteView } from "@/services/quote/read";
import type { CustomerHoldView } from "@/services/reservation/read";

const usd = (minor: number) => format(cents(minor));
const formatTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

type Props = {
  quote: CustomerQuoteView;
  /** The hold on an accepted price, when there is one. */
  hold?: CustomerHoldView | null;
  accept: (previous: AcceptState, formData: FormData) => Promise<AcceptState>;
};

function holdText(hold: CustomerHoldView): string {
  if (hold.state === "HELD") return hold.expiresAt ? `Your items are held until ${formatTime(hold.expiresAt)}.` : "Your items are being held.";
  if (hold.state === "SECURED") return "Your items are reserved for you.";
  return "The hold on your items has ended. If you still want them, ask the shop to hold them again.";
}

/**
 * The exact price the customer is being asked to accept: each item with its price, the price per box, how many boxes, the total, how
 * long it is held, and anything to know. The terms below are the words that were hashed and accepted, shown exactly as stored.
 */
export function QuoteCard({ quote, hold, accept }: Props) {
  return (
    <section aria-label="Your price" className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Your price</h2>
        {quote.version > 1 ? <p className="text-sm">This is an updated price. It replaces the earlier one.</p> : null}
        <p className="text-xs text-muted-foreground">Prices in US dollars. Sandbox demo with synthetic data.</p>
      </header>

      <table className="w-full text-sm">
        <caption className="sr-only">What is in each box</caption>
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-1 font-medium">Item</th>
            <th className="py-1 text-right font-medium">In each box</th>
            <th className="py-1 text-right font-medium">Price</th>
          </tr>
        </thead>
        <tbody>
          {quote.lines.map((line, i) => (
            <tr key={`${line.name}-${i}`} className="border-b border-border/50">
              <td className="py-1">{line.name}</td>
              <td className="py-1 text-right tabular-nums">{line.quantity}</td>
              <td className="py-1 text-right tabular-nums">{usd(line.unitPriceMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt>Price per box</dt>
        <dd className="text-right tabular-nums">{usd(quote.perBoxMinor)}</dd>
        <dt>Number of boxes</dt>
        <dd className="text-right tabular-nums">{quote.boxCount}</dd>
        <dt className="font-semibold">Total</dt>
        <dd className="text-right font-semibold tabular-nums">{usd(quote.totalMinor)}</dd>
      </dl>

      {quote.conditions.length > 0 ? (
        <div data-conditions>
          <h3 className="text-sm font-medium">Things to know about this price</h3>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {quote.conditions.map((c, i) => (
              <li key={`${c.code}-${i}`}>{c.text}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div data-terms>
        <h3 className="text-sm font-medium">What you are agreeing to</h3>
        <p className="mt-1 whitespace-pre-line text-sm">{quote.terms}</p>
      </div>

      {quote.status === "ACCEPTED" ? (
        <>
          <p role="status" className="rounded-md bg-muted p-3 text-sm">
            You accepted this exact price{quote.acceptedAt ? ` on ${formatTime(quote.acceptedAt)}` : ""}. Payment is the next step.
          </p>
          {hold ? <p className="text-sm">{holdText(hold)}</p> : null}
        </>
      ) : quote.expired ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          This price expired{quote.expiresAt ? ` on ${formatTime(quote.expiresAt)}` : ""}. Ask the shop for a new one.
        </p>
      ) : (
        <>
          {quote.expiresAt ? <p className="text-xs text-muted-foreground">You can accept this price until {formatTime(quote.expiresAt)}.</p> : null}
          <AcceptQuoteForm action={accept} quoteId={quote.quoteId} hash={quote.hash} />
        </>
      )}
    </section>
  );
}
