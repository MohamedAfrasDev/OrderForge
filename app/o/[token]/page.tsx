import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Conversation } from "@/components/conversation";
import { CustomerHeader } from "@/components/customer-header";
import { JobStatus } from "@/components/job-status";
import { INQUIRY_STATUSES, type InquiryStatus } from "@/domain/intake";
import { journeyOf } from "@/domain/journey";
import { PaymentStatus } from "@/components/payment-status";
import { QuoteCard } from "@/components/quote-card";
import { getCustomerMessages } from "@/lib/access/inquiry-reads";
import { authorizeCustomerToken } from "@/lib/access/customer-session";
import { createAdminClient } from "@/lib/supabase/admin";
import { jobStatusForCustomer } from "@/services/fulfillment/read";
import { paymentNoticeOf } from "@/services/payments/customer-messages";
import { paymentStatusForCustomer } from "@/services/payments/read";
import { readCustomerQuote } from "@/services/quote/read";
import { requirementsForCustomer, unansweredMessageId } from "@/services/intake/read";
import { readHoldForCustomer } from "@/services/reservation/read";
import { acceptQuoteAction, payWithPayPalAction } from "./actions";
import { IntakePanels } from "./intake-panels";

// The token is a credential: keep it out of search indexes and Referer headers.
export const metadata: Metadata = {
  title: "Your request · OrderForge",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
// A message runs the assistant inside the request.
export const maxDuration = 60;

export default function OrderRoomPage({ params, searchParams }: PageProps<"/o/[token]">) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-12">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <OrderRoom params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

// Reading route params is request-time data, so this streams inside <Suspense>.
async function OrderRoom({ params, searchParams }: { params: PageProps<"/o/[token]">["params"]; searchParams: PageProps<"/o/[token]">["searchParams"] }) {
  const { token } = await params;
  const notice = paymentNoticeOf((await searchParams).payment);
  const access = await authorizeCustomerToken(token);
  // Every failure looks the same: a link that does not work is just "not found".
  if (!access.ok) notFound();

  const { inquiry } = access;
  const db = createAdminClient();
  const messages = await getCustomerMessages(db, inquiry.id);
  const now = new Date().toISOString();
  const quote = await readCustomerQuote(db, inquiry.id, now);
  const hold = quote?.status === "ACCEPTED" ? await readHoldForCustomer(db, inquiry.id, now) : null;
  const payment = quote?.status === "ACCEPTED" ? await paymentStatusForCustomer(db, inquiry.id) : null;
  const job = quote?.status === "ACCEPTED" ? await jobStatusForCustomer(db, inquiry.id) : null;
  // Once a quote is accepted the conversation is about paying and collecting, not about what to order.
  const intake = quote?.status === "ACCEPTED" ? null : { spec: await requirementsForCustomer(db, inquiry.id), unanswered: (await unansweredMessageId(db, inquiry.id)) !== null };

  const inquiryStatus: InquiryStatus = (INQUIRY_STATUSES as readonly string[]).includes(inquiry.status) ? (inquiry.status as InquiryStatus) : "NEW";
  const quoteState = quote === null ? "NONE" : quote.status === "ACCEPTED" ? "ACCEPTED" : quote.expired ? "EXPIRED" : "PUBLISHED";
  const journey = journeyOf({ inquiry: inquiryStatus, quote: quoteState, payment: payment?.status ?? null, job: job?.status ?? null, stalled: Boolean(intake?.unanswered) });

  // With the order still being built, the conversation sits beside "Your order so far"; once it is accepted it stands alone.
  const talk = intake ? (
    <IntakePanels token={token} spec={intake.spec} status={inquiry.status} unanswered={intake.unanswered} messages={messages} shopName={inquiry.merchantName} />
  ) : (
    <Conversation messages={messages} shopName={inquiry.merchantName} />
  );

  return (
    <>
      <CustomerHeader shopName={inquiry.merchantName} journey={journey} />

      {/* In the order the customer meets them. Before there is a price: the conversation, then the order so far, the boxes and the box to
          write in. Once there is a price, what they have to do now comes first and the conversation follows. */}
      {quote ? (
        <>
          <QuoteCard quote={quote} hold={hold} accept={acceptQuoteAction.bind(null, token)} />
          {payment ? <PaymentStatus view={payment} notice={notice} pay={payWithPayPalAction.bind(null, token)} /> : null}
          {job ? <JobStatus view={job} /> : null}
          {talk}
        </>
      ) : (
        talk
      )}

      <p className="text-xs text-muted-foreground">
        This page is private to anyone who has the link. Keep the link to yourself.
      </p>
    </>
  );
}
