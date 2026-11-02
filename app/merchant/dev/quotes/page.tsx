import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireMerchant } from "@/lib/access/require-merchant";
import { DemoControls } from "./demo-controls";

export const metadata: Metadata = { title: "Demo quotes · OrderForge" };

export default function DemoQuotesPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-12">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Demo />
      </Suspense>
    </main>
  );
}

// The session is request-time data, so this streams inside <Suspense>.
async function Demo() {
  const { merchant } = await requireMerchant();
  return (
    <>
      <header className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">{merchant.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Demo quotes</h1>
        <p className="text-sm">
          Until the intake step exists, these make a synthetic 30-box inquiry and quote for your merchant so the review queue and the
          customer&apos;s order room can be tried end to end. Sandbox only, synthetic data.
        </p>
        <Link href="/merchant/quotes" className="text-sm underline">
          Go to the review queue
        </Link>
      </header>
      <DemoControls />
    </>
  );
}
