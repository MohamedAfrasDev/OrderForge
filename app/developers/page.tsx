import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { DEVELOPERS as c } from "@/lib/developers/content";
import { BLOCKED_BODY, FITS_BODY, contractFields, createCurl, exampleResponse, pretty, readCurl } from "@/lib/developers/example";
import { AGENT_LIMITS } from "@/lib/agent-api/limits";
import { cn } from "@/lib/utils";
import { cents, format } from "@/lib/money";
import { DEFAULT_DAILY_CAP_PER_STORE } from "@/services/agent-requests/create";
import { CopyButton } from "./copy-button";

export const metadata: Metadata = {
  title: "For agent developers · OrderForge",
  description: "The small public interface an agent can use to ask a demo shop for a priced box. It can request and read; it cannot accept or pay. Sandbox demo with synthetic data.",
};

function Code({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <pre tabIndex={0} className="select-all overflow-x-auto rounded-lg border border-border bg-muted p-4 font-mono text-xs leading-relaxed" aria-label={label}>
        <code>{text}</code>
      </pre>
      <div><CopyButton text={text} label={`Copy: ${label}`} /></div>
    </div>
  );
}

// The example answers are produced when the page is built, by the same handler and pricing engine the API uses.
export default async function DevelopersPage() {
  const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const fields = contractFields();
  const [fits, blocked] = await Promise.all([exampleResponse(baseUrl, FITS_BODY), exampleResponse(baseUrl, BLOCKED_BODY)]);
  const box = fits.request.proposals[0];
  const swap = blocked.request.proposals.find((p) => p.kind === "SWAP");
  const limits: Array<[string, string]> = [
    ["Requests one address may create", `${AGENT_LIMITS.createPerAddress} a minute`],
    ["Requests all addresses may create for one shop", `${AGENT_LIMITS.createPerStore} a minute`],
    ["Reads and browsing, per address", `${AGENT_LIMITS.readPerAddress} a minute`],
    ["Requests one shop takes through this interface", `${DEFAULT_DAILY_CAP_PER_STORE} in 24 hours`],
  ];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-6 py-12 sm:py-16">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{c.title}</h1>
        <p className="text-lg text-muted-foreground">{c.lead}</p>
        <div className="rounded-lg border border-border p-4">
          <p className="text-lg font-semibold">{c.rule}</p>
          <p className="mt-2 text-sm text-muted-foreground">{c.ruleDetail}</p>
        </div>
      </header>

      <section aria-labelledby="contract" className="flex flex-col gap-3">
        <h2 id="contract" className="text-xl font-semibold">{c.contractTitle}</h2>
        <p className="text-sm text-muted-foreground">{c.contractIntro}</p>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-xs uppercase tracking-wide">
              <tr><th className="p-3">Field</th><th className="p-3">Type</th><th className="p-3">Needed</th><th className="p-3">Range</th><th className="p-3">Meaning</th></tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.name} className="border-t border-border align-top">
                  <td className="p-3 font-mono text-xs">{f.name}</td>
                  <td className="p-3">{f.type}</td>
                  <td className="p-3">{f.required ? "yes" : "optional"}</td>
                  <td className="p-3">{f.range || "none"}</td>
                  <td className="p-3">{f.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="request" className="flex flex-col gap-3">
        <h2 id="request" className="text-xl font-semibold">{c.requestTitle}</h2>
        <p className="text-sm text-muted-foreground">{c.requestIntro}</p>
        <Code text={createCurl(baseUrl, FITS_BODY)} label="curl for a request of twenty boxes" />
      </section>

      <section aria-labelledby="response" className="flex flex-col gap-3">
        <h2 id="response" className="text-xl font-semibold">{c.responseTitle}</h2>
        <p className="text-sm text-muted-foreground">{c.responseIntro}</p>
        {box ? (
          <p className="text-sm">
            For {box.boxCount} boxes, code priced <strong>{format(cents(box.perBoxMinor))}</strong> a box and <strong>{format(cents(box.totalMinor))}</strong> in total, shown below as <code>{box.perBoxMinor}</code> and <code>{box.totalMinor}</code> cents.
          </p>
        ) : null}
        <Code text={pretty(fits)} label="response for a request of twenty boxes" />
      </section>

      <section aria-labelledby="read" className="flex flex-col gap-3">
        <h2 id="read" className="text-xl font-semibold">{c.readTitle}</h2>
        <p className="text-sm text-muted-foreground">{c.readIntro}</p>
        <Code text={readCurl(baseUrl)} label="curl to read the request back" />
      </section>

      <section aria-labelledby="blocked" className="flex flex-col gap-3">
        <h2 id="blocked" className="text-xl font-semibold">{c.blockedTitle}</h2>
        <p className="text-sm text-muted-foreground">{c.blockedIntro}</p>
        {swap ? (
          <p className="text-sm">
            For {swap.boxCount} boxes the swap is priced at <strong>{format(cents(swap.perBoxMinor))}</strong> a box and <strong>{format(cents(swap.totalMinor))}</strong> in total.
          </p>
        ) : null}
        <Code text={pretty(blocked)} label="response for a request of thirty boxes" />
      </section>

      <section aria-labelledby="handoff" className="flex flex-col gap-4">
        <h2 id="handoff" className="text-xl font-semibold">{c.handoffTitle}</h2>
        <ol className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {c.handoffSteps.map((s, i) => (
            <li key={s.who} className="flex flex-1 gap-3 rounded-lg border border-border p-3 text-sm sm:min-w-40">
              <span aria-hidden="true" className="font-semibold text-muted-foreground">{i + 1}</span>
              <span><span className="font-medium">{s.who}. </span>{s.what}</span>
            </li>
          ))}
        </ol>
        <div className="rounded-lg border border-border p-4">
          <h3 className="font-medium">{c.cannotTitle}</h3>
          <ul className="mt-2 list-disc pl-5 text-sm">
            {c.cannot.map((x) => <li key={x}>{x}</li>)}
          </ul>
        </div>
      </section>

      <section aria-labelledby="reference" className="flex flex-col gap-3">
        <h2 id="reference" className="text-xl font-semibold">{c.referenceTitle}</h2>
        <div><a href="/api/agent/v1/openapi.json" className={cn(buttonVariants({ variant: "outline" }))}>{c.openApiLink}</a></div>
        <p className="text-sm text-muted-foreground">{c.limitsIntro}</p>
        <dl className="grid gap-2 text-sm sm:grid-cols-[1fr_auto]">
          {limits.map(([what, value]) => (
            <div key={what} className="contents">
              <dt>{what}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="flex flex-col gap-4 border-t border-border pt-6">
        <p className="text-sm text-muted-foreground">{c.sandbox}</p>
        <div><Link href="/" className={cn(buttonVariants({ size: "lg" }))}>{c.homeLink}</Link></div>
      </footer>
    </main>
  );
}
