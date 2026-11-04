"use client";

import type { ColDef } from "ag-grid-community";
import { DataGrid } from "@/components/data-grid";
import { cents, format } from "@/lib/money";

export type ProductRow = {
  id: string;
  sku: string;
  name: string;
  category: string;
  priceMinor: number;
  isFood: boolean;
  active: boolean;
  onHand: number;
  held: number;
  available: number;
};

const number = { type: "numericColumn", filter: "agNumberColumnFilter", minWidth: 90 } as const;

const columns: ColDef<ProductRow>[] = [
  { field: "sku", headerName: "SKU", cellClass: "font-mono text-xs", minWidth: 150 },
  { field: "name", headerName: "Name", minWidth: 170 },
  { field: "category", headerName: "Category" },
  { field: "priceMinor", headerName: "Price", valueFormatter: (p) => format(cents(p.value as number)), ...number },
  { field: "isFood", headerName: "Food", valueFormatter: (p) => (p.value ? "Food" : "") },
  { field: "active", headerName: "Active", valueFormatter: (p) => (p.value ? "Yes" : "No") },
  { field: "onHand", headerName: "On hand", ...number },
  { field: "held", headerName: "Held", ...number },
  // Last on purpose: what can be sold now (on hand minus held).
  { field: "available", headerName: "Available", ...number },
];

/** The shop's products as a grid. Read only for now; editing arrives with the catalog editor. */
export function CatalogGrid({ rows }: { rows: ProductRow[] }) {
  return <DataGrid label="Products" searchLabel="Search products" rows={rows} columns={columns} emptyText="No products yet." />;
}
