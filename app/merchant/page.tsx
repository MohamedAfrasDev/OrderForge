import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { requireMerchant } from "@/lib/access/require-merchant";
import { signOut } from "./actions";

export const metadata: Metadata = { title: "Merchant portal · OrderForge" };

export default function MerchantHomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-24 text-center">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Dashboard />
      </Suspense>
    </main>
  );
}

// Reading the session cookie is a runtime API, so this part streams inside <Suspense>.
async function Dashboard() {
  const { merchant, user } = await requireMerchant();
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">{merchant.name}</h1>
      <p className="text-muted-foreground">Signed in as {user.email}</p>
      <Link href="/merchant/catalog" className="text-sm underline">
        Catalog
      </Link>
      <Link href="/merchant/quotes" className="text-sm underline">
        Quote review
      </Link>
      <Link href="/merchant/holds" className="text-sm underline">
        Stock holds
      </Link>
      <Link href="/merchant/decisions" className="text-sm underline">
        Payment decisions
      </Link>
      <form action={signOut}>
        <Button type="submit" variant="outline">
          Sign out
        </Button>
      </form>
    </>
  );
}
