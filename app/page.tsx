import { Suspense } from "react";
import { findDemoStore } from "@/lib/demo-store";
import { createAdminClient } from "@/lib/supabase/admin";
import { HomeActions } from "./home-actions";

const STEPS = ["Tell us what you need", "Choose a box and see the exact price", "Approve on PayPal and follow your order"];

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-16 text-center sm:py-24">
      <div className="flex flex-col items-center gap-4">
        <h1 className="text-4xl font-semibold tracking-tight">OrderForge</h1>
        <p className="max-w-lg text-lg text-muted-foreground">
          Order custom gift boxes by describing what you need, see an exact price, and approve it on PayPal; you&apos;re charged only if the shop accepts.
        </p>
      </div>

      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <Actions />
      </Suspense>

      <ol className="grid w-full max-w-2xl gap-3 text-left text-sm sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step} className="flex gap-3 rounded-lg border border-border p-3">
            <span aria-hidden="true" className="font-semibold text-muted-foreground">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </main>
  );
}

// Reading the database is request-time data, so this streams inside <Suspense>.
async function Actions() {
  return <HomeActions store={await findDemoStore(createAdminClient())} />;
}
