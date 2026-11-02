import type { Metadata } from "next";
import { Suspense } from "react";
import { requireMerchant } from "@/lib/access/require-merchant";
import { spikeTarget } from "@/lib/paypal/spike-wiring";
import { SpikeControls } from "./spike-controls";

export const metadata: Metadata = { title: "PayPal sandbox spike · OrderForge" };

export default function PayPalSpikePage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-12">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Spike />
      </Suspense>
    </main>
  );
}

// Session and environment are request-time data, so this streams inside <Suspense>.
async function Spike() {
  const { merchant } = await requireMerchant();
  const target = spikeTarget();

  return (
    <>
      <header className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">{merchant.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">PayPal sandbox spike</h1>
        <p className="text-sm">
          Proves authorize, then capture or void, with every step recorded as evidence. Amount is fixed at $10.80.
        </p>
        <p role="note" className="rounded-lg border border-border p-3 text-sm">
          Target:{" "}
          <strong data-testid="spike-target">
            {target.isFake ? "local fake PayPal (mocked)" : "the real PayPal sandbox"}
          </strong>
          . Evidence is labeled <code>{target.evidence}</code>.
        </p>
      </header>
      <SpikeControls isFake={target.isFake} />
    </>
  );
}
