import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { buttonVariants } from "@/components/ui/button";
import { demoScriptsFor, demoSlugs } from "@/domain/demo/scripts";
import { demoFigures } from "@/lib/demo/figures";
import { findDemoStores } from "@/lib/demo-store";
import { cents, format } from "@/lib/money";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";
import { DEMO as c, PROOF_URL, REPO_URL } from "./content";
import { startDemoRequest } from "./actions";
import { StartButton } from "./start-button";

export const metadata: Metadata = {
  title: "See the complete flow · OrderForge",
  description: "Start a real request in the OrderForge sandbox and follow it from a vague message to a price, a PayPal hold and the shop's decision. Synthetic data.",
};

const money = (minor: number) => format(cents(minor));

export default function DemoPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-6 py-12 sm:py-16">
      <header className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{c.title}</h1>
        <p className="flex flex-wrap gap-x-3 text-xl font-semibold">
          {c.line.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </p>
        <p className="text-lg text-muted-foreground">{c.lead}</p>
      </header>

      <section aria-labelledby="try" className="flex flex-col gap-4">
        <h2 id="try" className="text-xl font-semibold">{c.tryTitle}</h2>
        <p className="text-sm text-muted-foreground">{c.tryIntro}</p>
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
          <Shops />
        </Suspense>
      </section>

      <section aria-labelledby="stages" className="flex flex-col gap-4">
        <h2 id="stages" className="text-xl font-semibold">{c.stagesTitle}</h2>
        <ol className="flex flex-col gap-2">
          {c.stages.map((s, i) => (
            <li key={s.title} data-human={"human" in s && s.human ? "true" : undefined} className={cn("flex gap-4 rounded-lg border p-3", "human" in s && s.human ? "border-foreground" : "border-border")}>
              <span aria-hidden="true" className="font-semibold text-muted-foreground">{i + 1}</span>
              <div className="flex flex-col gap-1">
                <h3 className="font-medium">{s.title}</h3>
                <p className="text-sm text-muted-foreground">{s.detail}</p>
                {"human" in s && s.human && i === 2 ? <p className="text-xs font-semibold">{c.humanMark}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="need" className="flex flex-col gap-3">
        <h2 id="need" className="text-xl font-semibold">{c.needTitle}</h2>
        <p className="text-sm">{c.needCustomer}</p>
        <p className="text-sm">{c.needShop}</p>
        <div><Link href="/merchant" className={cn(buttonVariants({ variant: "outline" }))}>{c.shopLink}</Link></div>
      </section>

      <section aria-labelledby="links" className="flex flex-col gap-3">
        <h2 id="links" className="text-xl font-semibold">{c.linksTitle}</h2>
        <div className="flex flex-wrap gap-3">
          <Link href="/how-it-works" className={cn(buttonVariants({ variant: "outline" }))}>{c.links.how}</Link>
          <Link href="/developers" className={cn(buttonVariants({ variant: "outline" }))}>{c.links.developers}</Link>
          <a href="/api/agent/v1/openapi.json" className={cn(buttonVariants({ variant: "outline" }))}>{c.links.openapi}</a>
          <a href={REPO_URL} className={cn(buttonVariants({ variant: "outline" }))}>{c.links.repo}</a>
          <a href={PROOF_URL} className={cn(buttonVariants({ variant: "outline" }))}>{c.links.proof}</a>
        </div>
      </section>

      <footer className="border-t border-border pt-6">
        <p className="text-sm text-muted-foreground">{c.sandbox}</p>
      </footer>
    </main>
  );
}

// Which shops exist is request-time data. A shop that is not on this site gets no button, so nothing here can lead nowhere.
async function Shops() {
  const stores = await findDemoStores(createAdminClient(), demoSlugs());
  if (stores.length === 0) return <p className="text-sm text-muted-foreground">{c.noStore}</p>;
  return (
    <div className="flex flex-col gap-4">
      {stores.map((store) => {
        const figures = demoFigures(store.slug);
        return demoScriptsFor(store.slug).map((script) => (
          <div key={`${store.slug}-${script.key}`} data-store={store.slug} className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <h3 className="font-medium">{store.name}</h3>
            <p className="text-sm text-muted-foreground">{c.sends}</p>
            <blockquote className="border-l-2 border-border pl-3 text-sm">{script.message}</blockquote>
            <form action={startDemoRequest.bind(null, store.slug, script.key)} className="flex flex-col items-start gap-2">
              <StartButton label={script.label} working={c.working} />
            </form>

            <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
              <h4 className="text-sm font-semibold">{c.changeTitle}</h4>
              <p className="text-sm text-muted-foreground">{c.changeIntro}</p>
              <blockquote className="border-l-2 border-border pl-3 text-sm">{script.change.message}</blockquote>
              {figures ? (
                <p className="text-sm">
                  A box for {figures.fits.boxCount} is {money(figures.fits.perBoxMinor)} each, {money(figures.fits.totalMinor)} in total. The shop has {figures.blocked.available} of the{" "}
                  {figures.blocked.item.toLowerCase()} in stock, so {figures.blocked.boxCount} cannot include it. Code does not guess: it offers the {figures.blocked.swapItem.toLowerCase()} instead, at{" "}
                  {money(figures.blocked.swapPerBoxMinor)} each, {money(figures.blocked.swapTotalMinor)} in total, and you choose.
                </p>
              ) : null}
            </div>
          </div>
        ));
      })}
    </div>
  );
}
