import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireMerchant } from "@/lib/access/require-merchant";
import { createSessionClient } from "@/lib/supabase/server";
import { listInquiriesForMerchant, type MerchantInquiry } from "@/services/intake/read";
import { InquiryDetail } from "./inquiry-detail";
import { RequestsGrid, type RequestRow } from "./requests-grid";

export const metadata: Metadata = { title: "Requests · OrderForge" };

export default function MerchantInquiriesPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-10 sm:px-6">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Inquiries />
      </Suspense>
    </main>
  );
}

const excerpt = (text: string) => (text.length > 90 ? `${text.slice(0, 87)}...` : text);

function toRow(i: MerchantInquiry): RequestRow {
  const first = i.messages.find((m) => m.role === "customer");
  const boxes = i.fields.find((f) => f.name === "boxCount");
  const last = i.messages[i.messages.length - 1];
  return {
    id: i.inquiryId,
    handedOver: i.handedOverAt,
    request: excerpt(first?.body ?? "(no message)"),
    boxes: boxes?.value === null || boxes?.value === undefined ? "" : String(boxes.value),
    state: last?.role === "merchant" ? "You replied" : "Needs your reply",
  };
}

// Session and database reads are request-time data, so this streams inside <Suspense>.
// Reads run under the merchant's own session (row level security); the reply is in ./actions.
async function Inquiries() {
  const { merchant } = await requireMerchant();
  const inquiries = await listInquiriesForMerchant(await createSessionClient(), merchant.id);
  const details = Object.fromEntries(inquiries.map((i) => [i.inquiryId, <InquiryDetail key={i.inquiryId} inquiry={i} />]));

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{merchant.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Requests</h1>
        <p className="text-sm text-muted-foreground">
          Requests the assistant handed over, newest first. Choose one to read it and reply.{" "}
          <Link href="/merchant" className="underline">
            Back to Today
          </Link>
        </p>
      </header>
      <RequestsGrid rows={inquiries.map(toRow)} details={details} />
    </>
  );
}
