import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HOW_IT_WORKS as c, PROOF_URL, REPO_URL } from "./content";

export const metadata: Metadata = {
  title: "How it stays safe · OrderForge",
  description: "What goes wrong with custom orders by email, and the two rules OrderForge is built around. Sandbox demo with synthetic data.",
};

// Static: no login, no database, no per-request data.
export default function HowItWorksPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-6 py-12 sm:py-16">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{c.title}</h1>
        <p className="text-lg text-muted-foreground">{c.lead}</p>
      </header>

      <section aria-labelledby="problem" className="flex flex-col gap-2">
        <h2 id="problem" className="text-xl font-semibold">{c.problemTitle}</h2>
        <p>{c.problem}</p>
      </section>

      <section aria-labelledby="failures" className="flex flex-col gap-4">
        <h2 id="failures" className="text-xl font-semibold">{c.failuresTitle}</h2>
        <ol className="flex flex-col gap-4">
          {c.failures.map((f, i) => (
            <li key={f.problem} className="flex gap-4 rounded-lg border border-border p-4">
              <span aria-hidden="true" className="font-semibold text-muted-foreground">{i + 1}</span>
              <div className="flex flex-col gap-2">
                <h3 className="font-medium">{f.problem}</h3>
                <p className="text-sm text-muted-foreground">{f.detail}</p>
                <p className="text-sm"><span className="font-medium">What OrderForge does: </span>{f.answer}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="rules" className="flex flex-col gap-4">
        <h2 id="rules" className="text-xl font-semibold">{c.rulesTitle}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {c.rules.map((r) => (
            <div key={r.title} className="flex flex-col gap-2 rounded-lg border border-border p-4">
              <h3 className="font-medium">{r.title}</h3>
              <p className="text-sm">{r.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="check" className="flex flex-col gap-3">
        <h2 id="check" className="text-xl font-semibold">{c.checkTitle}</h2>
        <p>{c.check}</p>
        <div className="flex flex-wrap gap-3">
          <a href={PROOF_URL} className={cn(buttonVariants({ variant: "outline" }))}>{c.proofLink}</a>
          <a href={REPO_URL} className={cn(buttonVariants({ variant: "outline" }))}>{c.repoLink}</a>
        </div>
      </section>

      <footer className="flex flex-col gap-4 border-t border-border pt-6">
        <p className="text-sm text-muted-foreground">{c.sandbox}</p>
        <div className="flex flex-wrap gap-3">
          <Link href="/" className={cn(buttonVariants({ size: "lg" }))}>{c.demoLink}</Link>
        </div>
      </footer>
    </main>
  );
}
