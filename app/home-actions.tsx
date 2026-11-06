import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Store = { slug: string; name: string };

/**
 * What a visitor can do from the home page. The customer flow comes first and is shown only when the demo store exists; the shop's
 * sign-in is always there, second. Any other demo stores are offered by name as quieter links under the main action, so there is
 * still one clear thing to press. A store's name is never part of a link.
 */
export function HomeActions({ store, others = [] }: { store: Store | null; others?: Store[] }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex flex-wrap items-center justify-center gap-3">
        {store ? (
          <Link href={`/store/${encodeURIComponent(store.slug)}`} className={cn(buttonVariants({ size: "lg" }))}>
            Try it as a customer
          </Link>
        ) : null}
        <Link href="/demo" className={cn(buttonVariants({ size: "lg", variant: "outline" }))}>
          See the complete flow
        </Link>
        <Link href="/merchant" className={cn(buttonVariants({ size: "lg", variant: store ? "ghost" : "default" }))}>
          Shop sign in
        </Link>
      </div>
      {store ? <p className="text-sm text-muted-foreground">You&apos;ll order from {store.name}, a demo shop.</p> : <p className="text-sm text-muted-foreground">No store is open for orders on this site yet.</p>}
      {store && others.length > 0 ? (
        <p className="max-w-lg text-sm text-muted-foreground">
          Or try a different kind of shop, with its own products and stock:{" "}
          {others.map((o, i) => (
            <span key={o.slug}>
              {i > 0 ? ", " : null}
              <Link href={`/store/${encodeURIComponent(o.slug)}`} className="font-medium text-foreground underline underline-offset-4">
                {o.name}
              </Link>
            </span>
          ))}
          . All demo shops use simulated data.
        </p>
      ) : null}
    </div>
  );
}
