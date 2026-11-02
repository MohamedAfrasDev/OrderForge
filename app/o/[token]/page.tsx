import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { QuoteCard } from "@/components/quote-card";
import { getCustomerMessages } from "@/lib/access/inquiry-reads";
import { authorizeCustomerToken } from "@/lib/access/customer-session";
import { createAdminClient } from "@/lib/supabase/admin";
import { readCustomerQuote } from "@/services/quote/read";
import { acceptQuoteAction } from "./actions";

// The token is a credential: keep it out of search indexes and Referer headers.
export const metadata: Metadata = {
  title: "Your request · OrderForge",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function OrderRoomPage({ params }: PageProps<"/o/[token]">) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-12">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <OrderRoom params={params} />
      </Suspense>
    </main>
  );
}

const formatTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

// Reading route params is request-time data, so this streams inside <Suspense>.
async function OrderRoom({ params }: { params: PageProps<"/o/[token]">["params"] }) {
  const { token } = await params;
  const access = await authorizeCustomerToken(token);
  // Every failure looks the same: a link that does not work is just "not found".
  if (!access.ok) notFound();

  const { inquiry } = access;
  const db = createAdminClient();
  const messages = await getCustomerMessages(db, inquiry.id);
  const quote = await readCustomerQuote(db, inquiry.id, new Date().toISOString());

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{inquiry.merchantName}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Your request</h1>
        <p className="text-sm">
          Status: <span className="font-medium">{inquiry.status}</span>
        </p>
      </header>

      {quote ? <QuoteCard quote={quote} accept={acceptQuoteAction.bind(null, token)} /> : null}

      <section aria-label="Conversation" className="flex flex-col gap-3">
        {messages.length === 0 ? (
          <p className="text-muted-foreground">No messages yet.</p>
        ) : (
          messages.map((m) => (
            <article key={m.id} className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">
                {m.role} · {formatTime(m.createdAt)}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{m.body}</p>
            </article>
          ))
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        This page is private to anyone who has the link. Keep the link to yourself.
      </p>
    </>
  );
}
