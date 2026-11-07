import Link from "next/link";
import { Suspense } from "react";
import { findDemoStores } from "@/lib/demo-store";
import { createAdminClient } from "@/lib/supabase/admin";
import { HOME as c } from "./home-content";
import { HomeActions } from "./home-actions";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-10 px-6 py-14 text-center sm:py-20">
      <header className="flex flex-col items-center gap-5">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{c.title}</h1>
        <p className="flex flex-wrap justify-center gap-x-3 text-xl font-semibold sm:text-2xl">
          {c.line.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </p>
        <p className="max-w-xl text-base text-muted-foreground sm:text-lg">{c.problem}</p>
        <p className="max-w-xl text-base text-muted-foreground">{c.promise}</p>
      </header>

      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <Actions />
      </Suspense>

      <section aria-labelledby="flow" className="flex w-full flex-col gap-4">
        <h2 id="flow" className="text-sm font-semibold text-muted-foreground">{c.flowTitle}</h2>
        <ol className="flex w-full flex-col items-stretch gap-2 text-left sm:flex-row sm:items-stretch">
          {c.flow.map((step, i) => (
            <li key={step.who} className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex h-full flex-1 gap-3 rounded-lg border border-border p-3 text-sm">
                <span aria-hidden="true" className="font-semibold text-muted-foreground">{i + 1}</span>
                <span>
                  <span className="block font-medium">{step.who}</span>
                  <span className="text-muted-foreground">{step.what}</span>
                </span>
              </div>
              {i < c.flow.length - 1 ? (
                <span aria-hidden="true" className="self-center text-muted-foreground sm:-mx-1">
                  <span className="sm:hidden">↓</span>
                  <span className="hidden sm:inline">→</span>
                </span>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="text-sm">
          <Link href="/how-it-works" className="font-medium text-foreground underline underline-offset-4">
            {c.howLink}
          </Link>
        </p>
      </section>

      <footer className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
        <Link href="/developers" className="font-medium text-foreground underline underline-offset-4">
          {c.developers}
        </Link>
        <p>{c.sandbox}</p>
      </footer>
    </main>
  );
}

// Reading the database is request-time data, so this streams inside <Suspense>.
async function Actions() {
  const [first = null, ...others] = await findDemoStores(createAdminClient());
  return <HomeActions store={first} others={others} />;
}
