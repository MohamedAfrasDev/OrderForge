import Link from "next/link";
import { Suspense } from "react";
import { findDemoStores } from "@/lib/demo-store";
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

      <p className="text-sm">
        <Link href="/demo" className="font-medium text-foreground underline underline-offset-4">
          See the complete flow
        </Link>
      </p>

      <p className="max-w-lg text-sm text-muted-foreground">
        Custom orders agreed by message often end with a price that drifted, stock that isn&apos;t there, or a double charge. OrderForge checks each of those in code, not in the chat.{" "}
        <Link href="/how-it-works" className="font-medium text-foreground underline underline-offset-4">
          How it stays safe
        </Link>
      </p>

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

      <footer className="text-sm text-muted-foreground">
        <Link href="/developers" className="font-medium text-foreground underline underline-offset-4">
          For agent developers
        </Link>
      </footer>
    </main>
  );
}

// Reading the database is request-time data, so this streams inside <Suspense>.
async function Actions() {
  const [first = null, ...others] = await findDemoStores(createAdminClient());
  return <HomeActions store={first} others={others} />;
}
