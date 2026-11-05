import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { allowedMoves, type JobStatus } from "@/domain/fulfillment";
import { requireMerchant } from "@/lib/access/require-merchant";
import { cents, format } from "@/lib/money";
import { createSessionClient } from "@/lib/supabase/server";
import { listJobsForMerchant, type JobDetail } from "@/services/fulfillment/read";
import { JobForms, type Move } from "./job-forms";
import { PrintButton } from "./print-button";
import { JobsGrid, type JobGridRow } from "./jobs-grid";

export const metadata: Metadata = { title: "Jobs · OrderForge" };

export default function MerchantJobsPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Jobs />
      </Suspense>
    </main>
  );
}

const formatTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const usd = (minor: number) => format(cents(minor));

const STATUS_TEXT: Record<JobStatus, string> = {
  QUEUED: "Queued",
  PREPARING: "Preparing",
  READY_FOR_PICKUP: "Ready for pickup",
  COLLECTED: "Collected",
  ON_HOLD: "On hold",
};

const MOVE_LABEL: Record<string, string> = {
  PREPARING: "Start preparing",
  READY_FOR_PICKUP: "Mark ready for pickup",
  COLLECTED: "Record pickup",
  ON_HOLD: "Put on hold",
};

/** The moves open to this job right now. A resume goes back to where the hold started, which the event log records. */
function movesFor(job: JobDetail): Move[] {
  const heldFrom = job.status === "ON_HOLD" ? [...job.events].reverse().find((e) => e.status === "ON_HOLD")?.fromStatus ?? null : null;
  return allowedMoves(job.status, { heldFrom }).map((to) => ({
    to,
    label: job.status === "ON_HOLD" ? `Resume (back to ${STATUS_TEXT[to].toLowerCase()})` : (MOVE_LABEL[to] ?? to),
  }));
}

function JobCard({ job }: { job: JobDetail }) {
  const w = job.worksheet;
  return (
    <article aria-label={`Job for request ${job.inquiryId.slice(0, 8)}`} className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <header className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">
          Request {job.inquiryId.slice(0, 8)} · {w.boxCount} boxes
        </h3>
        <p className="text-sm">
          Status: <span className="font-medium">{STATUS_TEXT[job.status]}</span> · Ready by {job.readyBy} · Paid {usd(w.paid.totalMinor)}
        </p>
        <p className="text-xs text-muted-foreground">Collected by the customer from you (pickup). Quote version {w.quote.version}.</p>
      </header>

      <div data-pick-list>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-medium">Pick list</h4>
          <PrintButton />
        </div>
        <p className="mt-1 hidden text-sm print:block">
          Request {job.inquiryId.slice(0, 8)} · {w.boxCount} boxes · ready by {job.readyBy}
        </p>
        <ul className="mt-1 list-disc pl-5 text-sm">
          {w.pick.map((p) => (
            <li key={p.sku}>
              {p.quantity} × {p.name} ({p.sku})
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h4 className="text-sm font-medium">What goes in each box</h4>
        <ul className="mt-1 list-disc pl-5 text-sm">
          {w.perBox.map((l) => (
            <li key={l.slotId}>
              {l.quantityPerBox} × {l.name} ({l.slotId})
            </li>
          ))}
        </ul>
      </div>

      {w.conditions.length > 0 ? (
        <div>
          <h4 className="text-sm font-medium">Conditions on this order</h4>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {w.conditions.map((c) => (
              <li key={c.code}>
                {c.text} {c.confirmed ? "(you confirmed this)" : "(not confirmed)"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <h4 className="text-sm font-medium">History</h4>
        <ol className="mt-1 flex flex-col gap-1 text-sm">
          {job.events.map((e, i) => (
            <li key={`${e.at}-${i}`}>
              {formatTime(e.at)} · {STATUS_TEXT[e.status]}
              {e.note ? ` · ${e.note}` : ""}
            </li>
          ))}
        </ol>
      </div>

      <JobForms jobId={job.jobId} moves={movesFor(job)} />
    </article>
  );
}

// Session and database reads are request-time data, so this streams inside <Suspense>.
// Reads run under the merchant's own session (row level security); the moves are in ./actions.
async function Jobs() {
  const { merchant } = await requireMerchant();
  const jobs = await listJobsForMerchant(await createSessionClient(), merchant.id);
  const open = jobs.filter((j) => j.status !== "COLLECTED");
  const done = jobs.filter((j) => j.status === "COLLECTED");
  const gridRows = (list: JobDetail[]): JobGridRow[] => list.map((j) => ({ id: j.jobId, request: j.inquiryId.slice(0, 8), boxes: j.worksheet.boxCount, status: STATUS_TEXT[j.status], readyBy: j.readyBy, paidMinor: j.worksheet.paid.totalMinor }));
  const detailsOf = (list: JobDetail[]) => Object.fromEntries(list.map((j) => [j.jobId, <JobCard key={j.jobId} job={j} />]));

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{merchant.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <p className="text-sm text-muted-foreground">
          One job for each paid order, with the worksheet it was accepted as.{" "}
          <Link href="/merchant" className="underline">
            Back
          </Link>
        </p>
      </header>

      <section aria-labelledby="open-heading" className="flex flex-col gap-3">
        <h2 id="open-heading" className="text-lg font-semibold">
          To prepare
        </h2>
        <JobsGrid label="Jobs to prepare" emptyText="No jobs are waiting." rows={gridRows(open)} details={detailsOf(open)} />
      </section>

      <section aria-labelledby="done-heading" className="flex flex-col gap-3">
        <h2 id="done-heading" className="text-lg font-semibold">
          Collected
        </h2>
        <JobsGrid label="Jobs collected" emptyText="Nothing has been collected yet." rows={gridRows(done)} details={detailsOf(done)} />
      </section>
    </>
  );
}
