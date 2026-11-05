import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireMerchant } from "@/lib/access/require-merchant";
import { cents, format } from "@/lib/money";
import { createSessionClient } from "@/lib/supabase/server";
import { NOTE_TEXT, quoteBuilderView } from "@/services/intake/merchant-quote";
import { QuoteForm } from "./quote-form";

export const metadata: Metadata = { title: "Build a quote · OrderForge" };

export default function BuildQuotePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-10 sm:px-6">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Builder params={params} />
      </Suspense>
    </main>
  );
}

// Session, route params and database reads are request-time data, so this streams inside <Suspense>. Read under the shop's own session.
async function Builder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { merchant } = await requireMerchant();
  const view = await quoteBuilderView(await createSessionClient(), merchant.id, id);

  if (!view) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Build a quote</h1>
        <p className="text-sm">This request is not waiting for a price from you. It may already have one, or it may be somewhere else in the shop.</p>
        <Link href="/merchant/inquiries" className="text-sm underline">
          Back to requests
        </Link>
      </>
    );
  }

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{merchant.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Build a quote</h1>
        <p className="text-sm text-muted-foreground">
          <Link href="/merchant/inquiries" className="underline">
            Back to requests
          </Link>
        </p>
      </header>

      <section aria-label="What the customer asked for" className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">What the customer asked for</h2>
        {view.wishes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing was recorded. Read the conversation on the request.</p>
        ) : (
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            {view.wishes.map((w) => (
              <div key={w.name} className="contents">
                <dt className="font-medium">{w.label}</dt>
                <dd>{wish(w.name, w.value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <QuoteForm view={view} notes={{ artwork: NOTE_TEXT.ARTWORK_ACCEPTANCE, productionSlot: NOTE_TEXT.PRODUCTION_SLOT_CONFIRMATION }} />
    </>
  );
}

function wish(name: string, value: unknown): string {
  if (value === null || value === undefined) return "Not specified";
  if (name === "maxPricePerBoxMinor" && typeof value === "number") return format(cents(value));
  if (name === "noFood" || name === "logoRequired") return value === true ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}
