import type { AcceptState } from "@/app/o/[token]/actions";
import { AcceptQuoteForm } from "@/components/accept-quote-form";
import { cents, format } from "@/lib/money";
import type { CustomerQuoteView } from "@/services/quote/read";

const usd = (minor: number) => format(cents(minor));
const formatTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

type Props = {
  quote: CustomerQuoteView;
  accept: (previous: AcceptState, formData: FormData) => Promise<AcceptState>;
};

/** The exact quote the customer is being asked to accept, with its conditions and terms. */
export function QuoteCard({ quote, accept }: Props) {
  return (
    <section aria-label="Quote" className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Quote version {quote.version}</h2>
        <p className="text-xs text-muted-foreground">Prices in US dollars. Sandbox demo with synthetic data.</p>
      </header>

      <table className="w-full text-sm">
        <caption className="sr-only">What is in each box</caption>
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-1 font-medium">Item</th>
            <th className="py-1 text-right font-medium">Qty per box</th>
            <th className="py-1 text-right font-medium">Unit price</th>
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
        <div>
          <h3 className="text-sm font-medium">Conditions on this quote</h3>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {quote.conditions.map((c, i) => (
              <li key={`${c.code}-${i}`}>{c.text}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <h3 className="text-sm font-medium">What you are agreeing to</h3>
        <p className="mt-1 whitespace-pre-line text-sm">{quote.terms}</p>
      </div>

      {quote.status === "ACCEPTED" ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          You accepted this exact quote{quote.acceptedAt ? ` on ${formatTime(quote.acceptedAt)}` : ""}. Payment is the next step.
        </p>
      ) : quote.expired ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          This quote expired{quote.expiresAt ? ` on ${formatTime(quote.expiresAt)}` : ""}. Ask the merchant for a new one.
        </p>
      ) : (
        <>
          {quote.expiresAt ? <p className="text-xs text-muted-foreground">You can accept this quote until {formatTime(quote.expiresAt)}.</p> : null}
          <AcceptQuoteForm action={accept} quoteId={quote.quoteId} hash={quote.hash} />
        </>
      )}
    </section>
  );
}
