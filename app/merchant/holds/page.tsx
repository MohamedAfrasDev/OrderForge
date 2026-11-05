import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireMerchant } from "@/lib/access/require-merchant";
import { createSessionClient } from "@/lib/supabase/server";
import { HoldsGrid, type HoldGridRow } from "./holds-grid";
import { listHoldsForMerchant, type HoldRow } from "@/services/reservation/read";

export const metadata: Metadata = { title: "Stock holds · OrderForge" };

export default function MerchantHoldsPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Holds />
      </Suspense>
    </main>
  );
}

const formatTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

const STATE_TEXT: Record<string, string> = {
  HELD: "Held, waiting for payment",
  PAYMENT_IN_FLIGHT: "Payment in progress",
  AWAITING_CONFIRMATION: "Waiting for your decision",
  REVIEW_REQUIRED: "Needs attention",
};

function describe(hold: HoldRow): string {
  switch (hold.state) {
    case "HELD":
      return hold.expiresAt ? `Held until ${formatTime(hold.expiresAt)}, waiting for the customer to pay.` : "Held, waiting for the customer to pay.";
    case "PAYMENT_IN_FLIGHT":
      return `A payment step is in progress (${hold.inFlightOperation ?? "unknown"}). The stock cannot be released until it finishes.`;
    case "AWAITING_CONFIRMATION":
      return "Payment is authorized and waiting for your decision. The stock stays held.";
    case "REVIEW_REQUIRED":
      return "Needs attention. The stock stays held until someone resolves it.";
    default:
      return hold.state;
  }
}

function HoldCard({ hold }: { hold: HoldRow }) {
  return (
    <article aria-label={`Hold for request ${hold.inquiryId.slice(0, 8)}`} className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <header className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">Request {hold.inquiryId.slice(0, 8)}</h3>
        <p className="text-sm">{describe(hold)}</p>
        {hold.reviewReason ? <p className="text-sm text-muted-foreground">Note: {hold.reviewReason}</p> : null}
        <p className="text-xs text-muted-foreground">Last change {formatTime(hold.stateChangedAt)}</p>
      </header>
      <ul className="list-disc pl-5 text-sm">
        {hold.lines.map((line) => (
          <li key={line.sku}>
            {line.quantity} × {line.name} ({line.sku})
          </li>
        ))}
      </ul>
    </article>
  );
}

// Session and database reads are request-time data, so this streams inside <Suspense>.
// Read-only, under the merchant's own session (row level security); nothing here writes.
async function Holds() {
  const { merchant } = await requireMerchant();
  const holds = await listHoldsForMerchant(await createSessionClient(), merchant.id);
  const attention = holds.filter((h) => h.needsAttention);
  const current = holds.filter((h) => !h.needsAttention);
  const gridRows = (list: HoldRow[]): HoldGridRow[] => list.map((h) => ({ id: h.reservationId, request: h.inquiryId.slice(0, 8), state: STATE_TEXT[h.state] ?? h.state, items: h.lines.length, changed: h.stateChangedAt }));
  const detailsOf = (list: HoldRow[]) => Object.fromEntries(list.map((h) => [h.reservationId, <HoldCard key={h.reservationId} hold={h} />]));

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{merchant.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Stock holds</h1>
        <p className="text-sm text-muted-foreground">
          Stock set aside for customers who accepted a quote. A plain hold ends on its own if the customer does not pay in time; a hold with a
          payment under way never does.{" "}
          <Link href="/merchant" className="underline">
            Back
          </Link>
        </p>
      </header>

      <section aria-labelledby="attention-heading" className="flex flex-col gap-3">
        <h2 id="attention-heading" className="text-lg font-semibold">
          Needs attention
        </h2>
        <HoldsGrid label="Holds needing attention" emptyText="Nothing needs attention." rows={gridRows(attention)} details={detailsOf(attention)} />
      </section>

      <section aria-labelledby="current-heading" className="flex flex-col gap-3">
        <h2 id="current-heading" className="text-lg font-semibold">
          Current holds
        </h2>
        <HoldsGrid label="Current holds" emptyText="No stock is on hold." rows={gridRows(current)} details={detailsOf(current)} />
      </section>
    </>
  );
}
