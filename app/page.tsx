import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-24 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">OrderForge</h1>
      <p className="max-w-md text-lg text-muted-foreground">
        From one vague custom-order request to an approved, PayPal-authorized order, with the
        merchant confirming before any money moves.
      </p>
      <Link href="/merchant" className={cn(buttonVariants({ size: "lg" }))}>
        Merchant portal
      </Link>
    </main>
  );
}
