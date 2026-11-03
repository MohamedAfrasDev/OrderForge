import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireMerchant } from "@/lib/access/require-merchant";
import { cents, format } from "@/lib/money";
import { createSessionClient } from "@/lib/supabase/server";
import { listInquiriesForMerchant, type CustomerSpecField, type MerchantInquiry } from "@/services/intake/read";
import { ReplyForm } from "./reply-form";

export const metadata: Metadata = { title: "Inquiries · OrderForge" };

export default function MerchantInquiriesPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Inquiries />
      </Suspense>
    </main>
  );
}

const formatTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

const STATUS_WORDS: Record<string, string> = {
  confirmed: "confirmed",
  needs_confirmation: "needs confirmation",
  conflicted: "conflicting",
  unknown: "not specified",
};

function show(f: CustomerSpecField): string {
  const v = f.value;
  if (v === null || v === undefined) return "Not specified";
  if (f.name === "maxPricePerBoxMinor" && typeof v === "number") return format(cents(v));
  if (f.name === "noFood" || f.name === "logoRequired") return v === true ? "Yes" : "No";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function InquiryCard({ inquiry }: { inquiry: MerchantInquiry }) {
  return (
    <article aria-label={`Inquiry ${inquiry.inquiryId.slice(0, 8)}`} className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <header className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">Inquiry {inquiry.inquiryId.slice(0, 8)}</h3>
        <p className="text-sm text-muted-foreground">Handed over {formatTime(inquiry.handedOverAt)}</p>
      </header>

      <div>
        <h4 className="text-sm font-medium">What the customer wants</h4>
        {inquiry.fields.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Nothing was recorded before the handover. Read the conversation below.</p>
        ) : (
          <dl className="mt-1 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            {inquiry.fields.map((f) => (
              <div key={f.name} className="contents">
                <dt className="font-medium">{f.label}</dt>
                <dd>
                  {show(f)}
                  {f.status === "unknown" ? null : <span className="text-xs text-muted-foreground"> ({STATUS_WORDS[f.status]})</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {inquiry.question ? <p className="mt-2 text-sm">The assistant was waiting on: {inquiry.question}</p> : null}
      </div>

      <div>
        <h4 className="text-sm font-medium">Conversation</h4>
        <ol className="mt-1 flex flex-col gap-2">
          {inquiry.messages.map((m) => (
            <li key={m.id} className="rounded-md border border-border p-2">
              <p className="text-xs text-muted-foreground">
                {m.role} · {formatTime(m.createdAt)}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{m.body}</p>
            </li>
          ))}
        </ol>
      </div>

      <ReplyForm inquiryId={inquiry.inquiryId} />
    </article>
  );
}

// Session and database reads are request-time data, so this streams inside <Suspense>.
// Reads run under the merchant's own session (row level security); the reply is in ./actions.
async function Inquiries() {
  const { merchant } = await requireMerchant();
  const inquiries = await listInquiriesForMerchant(await createSessionClient(), merchant.id);

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{merchant.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Inquiries</h1>
        <p className="text-sm text-muted-foreground">
          Requests the assistant handed over, newest first.{" "}
          <Link href="/merchant" className="underline">
            Back
          </Link>
        </p>
      </header>

      {inquiries.length === 0 ? (
        <p className="text-muted-foreground">No inquiries are waiting for you.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {inquiries.map((i) => (
            <li key={i.inquiryId}>
              <InquiryCard inquiry={i} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
