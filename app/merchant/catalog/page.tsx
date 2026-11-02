import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireMerchant } from "@/lib/access/require-merchant";
import { format } from "@/lib/money";
import { createSessionClient } from "@/lib/supabase/server";
import { CatalogLoadError, loadCatalogSnapshot } from "@/services/catalog/load-snapshot";

export const metadata: Metadata = { title: "Catalog · OrderForge" };

export default function MerchantCatalogPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Catalog />
      </Suspense>
    </main>
  );
}

// Session and database reads are request-time data, so this streams inside <Suspense>.
// Read-only: the merchant's own rows are read under row level security, and nothing here writes.
async function Catalog() {
  const { merchant } = await requireMerchant();
  const db = await createSessionClient();

  let snapshot;
  try {
    snapshot = await loadCatalogSnapshot(db, merchant.id);
  } catch (error) {
    if (!(error instanceof CatalogLoadError)) throw error;
    return (
      <>
        <PageHeader name={merchant.name} />
        <p role="alert" className="rounded-lg border border-destructive p-3 text-sm">
          The catalog cannot be shown: {error.message}
        </p>
      </>
    );
  }

  const { catalog, stock } = snapshot;
  const nameOf = new Map(catalog.products.map((p) => [p.sku, p.name]));

  return (
    <>
      <PageHeader name={merchant.name} />

      <section aria-labelledby="products-heading" className="flex flex-col gap-3">
        <h2 id="products-heading" className="text-lg font-semibold">
          Products
        </h2>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">SKU</th>
                <th scope="col" className="px-3 py-2 font-medium">Name</th>
                <th scope="col" className="px-3 py-2 font-medium">Category</th>
                <th scope="col" className="px-3 py-2 font-medium">Price</th>
                <th scope="col" className="px-3 py-2 font-medium">Food</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Available</th>
              </tr>
            </thead>
            <tbody>
              {catalog.products.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">{p.sku}</td>
                  <td className="px-3 py-2">
                    {p.name}
                    {!p.active && <span className="ml-2 text-xs text-muted-foreground">(inactive)</span>}
                  </td>
                  <td className="px-3 py-2">{p.category}</td>
                  <td className="px-3 py-2">{format(p.unitPriceMinor)}</td>
                  <td className="px-3 py-2">{p.isFood ? "Food" : ""}</td>
                  <td className="px-3 py-2 text-right">{stock[p.id] ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="template-heading" className="flex flex-col gap-3">
        <h2 id="template-heading" className="text-lg font-semibold">
          Box template
        </h2>
        <ul className="flex flex-col gap-2">
          {catalog.slots.map((slot) => (
            <li key={slot.id} className="rounded-lg border border-border p-3 text-sm">
              <p className="font-medium">
                {slot.label}
                {slot.quantity > 1 && <span className="ml-2 text-muted-foreground">× {slot.quantity}</span>}
                {slot.customization === "logo" && (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">Logo</span>
                )}
              </p>
              <p className="text-muted-foreground">
                {slot.allowedSkus.map((sku) => nameOf.get(sku) ?? sku).join(", ")}
              </p>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          Production lead time: {catalog.rules.productionLeadDays} days
          {catalog.rules.minOrderQuantity !== undefined && <> · Minimum order: {catalog.rules.minOrderQuantity} boxes</>}
        </p>
      </section>
    </>
  );
}

function PageHeader({ name }: { name: string }) {
  return (
    <header className="flex flex-col gap-1">
      <p className="text-sm text-muted-foreground">
        {name} · <Link href="/merchant" className="underline">Back to portal</Link>
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>
    </header>
  );
}
