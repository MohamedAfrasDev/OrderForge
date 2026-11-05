import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireMerchant } from "@/lib/access/require-merchant";
import { cents, format } from "@/lib/money";
import { createSessionClient } from "@/lib/supabase/server";
import { HONOR_PERIOD_DAYS, listDecisionsForMerchant, type DecisionRow } from "@/services/payments/read";
import { DecisionForms } from "./decision-forms";
import { DecisionsGrid, type DecisionGridRow } from "./decisions-grid";

export const metadata: Metadata = { title: "Payment decisions · OrderForge" };

export default function MerchantDecisionsPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Decisions />
      </Suspense>
    </main>
  );
}

const formatTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const usd = (minor: number) => format(cents(minor));

const EXCEPTION_TEXT: Record<string, string> = {
  AMOUNT_MISMATCH: "PayPal reported a different amount than the accepted quote.",
  CURRENCY_MISMATCH: "PayPal reported a different currency than the accepted quote.",
  ORDER_MISMATCH: "PayPal's record belongs to a different order.",
  AUTHORIZATION_MISMATCH: "PayPal's record belongs to a different authorization.",
  STATUS_NOT_AS_EXPECTED: "PayPal's status was not what was expected (for example, the money was already captured when a cancel was attempted).",
  PAYEE_MISMATCH: "The payment went to a different PayPal merchant than configured.",
  EVIDENCE_MISSING: "PayPal did not give enough evidence to confirm the payment.",
};

function Card({ row, children }: { row: DecisionRow; children?: React.ReactNode }) {
  return (
    <article aria-label={`Order for request ${row.inquiryId.slice(0, 8)}`} className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <header className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">
          Request {row.inquiryId.slice(0, 8)} · quote version {row.quoteVersion}
        </h3>
        <p className="text-sm">Total {usd(row.totalMinor)}</p>
        {row.authorizedAt ? <p className="text-xs text-muted-foreground">Authorized {formatTime(row.authorizedAt)}</p> : null}
        {row.authorizationExpiresAt ? <p className="text-xs text-muted-foreground">PayPal authorization runs until {formatTime(row.authorizationExpiresAt)}</p> : null}
      </header>
      {row.honorWarning ? (
        <p role="note" className="rounded-md bg-muted p-3 text-sm">
          This authorization is more than {HONOR_PERIOD_DAYS} days old. Capturing it may be less reliable; it is still attempted until PayPal refuses.
        </p>
      ) : null}
      {children}
    </article>
  );
}

// Session and database reads are request-time data, so this streams inside <Suspense>.
// Reads run under the merchant's own session (row level security); the actions are in ./actions.
async function Decisions() {
  const { merchant } = await requireMerchant();
  const rows = await listDecisionsForMerchant(await createSessionClient(), merchant.id, new Date().toISOString());
  const exceptions = rows.filter((r) => r.section === "exception");
  const waiting = rows.filter((r) => r.section === "waiting");
  const checking = rows.filter((r) => r.section === "checking");
  const gridRows = (list: DecisionRow[]): DecisionGridRow[] => list.map((r) => ({ id: r.purchaseId, request: r.inquiryId.slice(0, 8), version: r.quoteVersion, totalMinor: r.totalMinor, since: r.authorizedAt ?? "" }));
  const detailsOf = (list: DecisionRow[], body: (r: DecisionRow) => React.ReactNode) => Object.fromEntries(list.map((r) => [r.purchaseId, body(r)]));

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{merchant.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Payment decisions</h1>
        <p className="text-sm text-muted-foreground">
          Customers have authorized these orders with PayPal. Nothing is charged until you accept; declining cancels the authorization.{" "}
          <Link href="/merchant" className="underline">
            Back
          </Link>
        </p>
      </header>

      <section aria-labelledby="exceptions-heading" className="flex flex-col gap-3">
        <h2 id="exceptions-heading" className="text-lg font-semibold">
          Needs attention
        </h2>
        <DecisionsGrid
          label="Orders needing attention"
          emptyText="Nothing needs attention."
          rows={gridRows(exceptions)}
          details={detailsOf(exceptions, (r) => (
            <Card row={r}>
              <p className="text-sm">
                <span className="font-medium">Not marked as paid.</span> {EXCEPTION_TEXT[r.exceptionReason ?? ""] ?? "PayPal's records did not match."} The stock stays held until someone resolves it in
                PayPal.
              </p>
            </Card>
          ))}
        />
      </section>

      <section aria-labelledby="waiting-heading" className="flex flex-col gap-3">
        <h2 id="waiting-heading" className="text-lg font-semibold">
          Waiting for your decision
        </h2>
        <DecisionsGrid
          label="Orders waiting"
          emptyText="No authorized orders are waiting."
          rows={gridRows(waiting)}
          details={detailsOf(waiting, (r) => (
            <Card row={r}>
              {r.conditions.length > 0 ? (
                <div>
                  <h4 className="text-sm font-medium">Conditions on this quote</h4>
                  <ul className="mt-1 list-disc pl-5 text-sm">
                    {r.conditions.map((c) => (
                      <li key={c.code}>{c.text}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <DecisionForms purchaseId={r.purchaseId} conditions={r.conditions.filter((c) => c.needsConfirmation).map((c) => ({ code: c.code, text: c.text }))} />
            </Card>
          ))}
        />
      </section>

      <section aria-labelledby="checking-heading" className="flex flex-col gap-3">
        <h2 id="checking-heading" className="text-lg font-semibold">
          Being checked
        </h2>
        <DecisionsGrid
          label="Orders being checked"
          emptyText="Nothing is being checked."
          rows={gridRows(checking)}
          details={detailsOf(checking, (r) => (
            <Card row={r}>
              <p className="text-sm">A payment step is being carried out or confirmed with PayPal. It is never sent twice; this page updates when PayPal confirms.</p>
            </Card>
          ))}
        />
      </section>
    </>
  );
}
