import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { requireMerchant } from "@/lib/access/require-merchant";
import { cn } from "@/lib/utils";
import { createSessionClient } from "@/lib/supabase/server";
import { merchantOverview } from "@/services/merchant/overview";
import { signOut } from "./actions";

export const metadata: Metadata = { title: "Today · OrderForge" };

export default function MerchantHomePage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Today />
      </Suspense>
    </main>
  );
}

type Card = { id: string; count: number; title: string; waiting: (n: number) => string; nothing: string; href: string; button: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Reading the session cookie is a runtime API, so this part streams inside <Suspense>. The counts are read under the shop's own session.
async function Today() {
  const { merchant, user } = await requireMerchant();
  const overview = await merchantOverview(await createSessionClient(), merchant.id);

  const cards: Card[] = [
    {
      id: "requests",
      count: overview.requestsToAnswer,
      title: "Requests",
      waiting: (n) => `${plural(n, "request needs", "requests need")} your answer`,
      nothing: "Nothing waiting for your answer.",
      href: "/merchant/inquiries",
      button: "Open requests",
    },
    {
      id: "payments",
      count: overview.paymentsToDecide,
      title: "Orders to approve",
      waiting: (n) => `${plural(n, "order is", "orders are")} waiting for your OK`,
      nothing: "No orders are waiting for your OK.",
      href: "/merchant/decisions",
      button: "Review orders",
    },
    {
      id: "prepare",
      count: overview.ordersToPrepare,
      title: "Orders to prepare",
      waiting: (n) => `${plural(n, "order is", "orders are")} not picked up yet`,
      nothing: "No orders to prepare.",
      href: "/merchant/jobs",
      button: "Prepare orders",
    },
  ];

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{merchant.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight">Today</h1>
        <p className="text-sm text-muted-foreground">Signed in as {user.email}</p>
      </header>

      <ul className="grid gap-4 sm:grid-cols-3">
        {cards.map((c) => (
          <li key={c.id}>
            <section aria-label={c.title} data-testid={`today-${c.id}`} data-count={c.count} className="flex h-full flex-col gap-3 rounded-lg border border-border p-4">
              <h2 className="text-sm font-medium text-muted-foreground">{c.title}</h2>
              <p className="text-4xl font-semibold tabular-nums">{c.count}</p>
              <p className="text-sm">{c.count === 0 ? c.nothing : c.waiting(c.count)}</p>
              <Link href={c.href} className={cn(buttonVariants({ variant: c.count === 0 ? "outline" : "default" }), "mt-auto")}>
                {c.button}
              </Link>
            </section>
          </li>
        ))}
      </ul>

      <section aria-label="More" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">More</h2>
        <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <li>
            <Link href="/merchant/catalog" className="underline">
              Catalog
            </Link>
          </li>
          <li>
            <Link href="/merchant/holds" className="underline">
              Stock holds
            </Link>
          </li>
          <li>
            <Link href="/merchant/quotes" className="underline">
              Quote review
            </Link>
          </li>
        </ul>
      </section>

      <form action={signOut}>
        <Button type="submit" variant="outline">
          Sign out
        </Button>
      </form>
    </>
  );
}
