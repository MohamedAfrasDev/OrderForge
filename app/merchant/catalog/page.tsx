import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireMerchant } from "@/lib/access/require-merchant";
import { createSessionClient } from "@/lib/supabase/server";
import { CatalogLoadError, loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { AddProduct } from "./add-product";
import { CatalogGrid, type ProductRow } from "./catalog-grid";

export const metadata: Metadata = { title: "Catalog · OrderForge" };

export default function MerchantCatalogPage() {
  return (
    <main className="mx-auto flex w-full min-w-0 max-w-5xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Catalog />
      </Suspense>
    </main>
  );
}

// Session and database reads are request-time data, so this streams inside <Suspense>.
// The merchant's own rows are read under row level security; changes go through the server actions in ./actions.
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

  // On hand and held come from the stock rows (the merchant's own, under row level security); available is on hand minus held.
  const stockRows = await db.from("stock").select("product_id, on_hand, reserved").in("product_id", catalog.products.map((p) => p.id));
  if (stockRows.error) throw new Error(`load stock: ${stockRows.error.message}`);
  const held = new Map((stockRows.data ?? []).map((s) => [s.product_id as string, { onHand: s.on_hand as number, held: s.reserved as number }]));
  const rows: ProductRow[] = catalog.products.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    category: p.category,
    priceMinor: p.unitPriceMinor,
    isFood: p.isFood,
    active: p.active,
    onHand: held.get(p.id)?.onHand ?? 0,
    held: held.get(p.id)?.held ?? 0,
    available: stock[p.id] ?? 0,
  }));

  return (
    <>
      <PageHeader name={merchant.name} />

      <section aria-labelledby="products-heading" className="flex flex-col gap-3">
        <h2 id="products-heading" className="text-lg font-semibold">
          Products
        </h2>
        <p className="text-sm text-muted-foreground">Double-click a cell, or select it and press Enter, to change it. Prices are in dollars and cents.</p>
        <CatalogGrid rows={rows} />
      </section>

      <section aria-labelledby="add-heading" className="flex flex-col gap-3">
        <h2 id="add-heading" className="text-lg font-semibold">
          Add a product
        </h2>
        <AddProduct slots={catalog.slots.map((s) => ({ id: s.id, label: s.label }))} />
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
