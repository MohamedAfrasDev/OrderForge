import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Not found · OrderForge", robots: { index: false, follow: false } };

/**
 * Every address that leads nowhere: a mistyped or out-of-date link, an order link that is wrong, expired or no longer valid, a store
 * that does not exist. One calm answer for all of them, so it never says whether a particular request exists.
 */
export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">We couldn&apos;t find that</h1>
      <p className="max-w-md text-muted-foreground">The link may be mistyped, out of date or no longer valid. Check the link you were given, or start again from the home page.</p>
      <Link href="/" className={cn(buttonVariants({ size: "lg" }))}>
        Go to the home page
      </Link>
    </main>
  );
}
