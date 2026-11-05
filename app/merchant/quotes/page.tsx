import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireMerchant } from "@/lib/access/require-merchant";
import { cents, format } from "@/lib/money";
import { createSessionClient } from "@/lib/supabase/server";
import { listReviewDrafts } from "@/services/quote/review-queue";
import { DraftsGrid, type DraftGridRow } from "./quotes-grid";
import { ReviewForms } from "./review-forms";

export const metadata: Metadata = { title: "Quote review · OrderForge" };

export default function MerchantQuotesPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Review />
      </Suspense>
    </main>
  );
}

const usd = (minor: number) => format(cents(minor));
const formatTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

// Session and database reads are request-time data, so this streams inside <Suspense>.
// The list is read under the merchant's own session (row level security); every change goes through a server action.
async function Review() {
  const { merchant } = await requireMerchant();
  const drafts = await listReviewDrafts(await createSessionClient(), merchant.id);

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{merchant.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Quote review</h1>
        <p className="text-sm text-muted-foreground">
          Draft quotes waiting for you. A quote with an item marked as needing your decision is only published when you approve it in your own words.{" "}
          <Link href="/merchant" className="underline">
            Back
          </Link>
        </p>
      </header>

      <DraftsGrid
        rows={drafts.map((d): DraftGridRow => ({ id: d.quoteId, request: d.inquiryId.slice(0, 8), version: d.version, totalMinor: d.totalMinor, needsDecision: d.needsDecision ? "Yes" : "", created: d.createdAt }))}
        details={Object.fromEntries(
          drafts.map((d) => [
            d.quoteId,
            <article
                key={d.quoteId}
                            aria-label={`Quote draft version ${d.version} for request ${d.inquiryId.slice(0, 8)}`}
                            className="flex flex-col gap-4 rounded-lg border border-border p-4"
                          >
                            <header className="flex flex-col gap-1">
                              <h2 className="text-lg font-semibold">
                                Version {d.version} · request {d.inquiryId.slice(0, 8)}
                              </h2>
                              <p className="text-xs text-muted-foreground">Created {formatTime(d.createdAt)}</p>
                              {d.needsDecision ? <p className="text-sm font-medium">Needs your decision</p> : null}
                            </header>
            
                            {d.readable ? (
                              <p className="text-sm">
                                {d.boxCount} boxes at {usd(d.perBoxMinor!)} per box, {usd(d.totalMinor)} total.
                              </p>
                            ) : (
                              <p role="alert" className="text-sm text-destructive">
                                The stored quote cannot be read. It cannot be published; withdraw it.
                              </p>
                            )}
            
                            {d.conditions.length > 0 ? (
                              <ul className="list-disc pl-5 text-sm">
                                {d.conditions.map((c, i) => (
                                  <li key={`${c.code}-${i}`}>
                                    {c.text}
                                    {c.code === "UNSUPPORTED_CUSTOMIZATION" ? " (not supported as it stands; needs your decision)" : ""}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
            
                            <ReviewForms quoteId={d.quoteId} needsDecision={d.needsDecision} />
                          </article>
          ]),
        )}
      />
    </>
  );
}
