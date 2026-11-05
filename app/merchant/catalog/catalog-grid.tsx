"use client";

import type { ColDef } from "ag-grid-community";
import { DataGrid } from "@/components/data-grid";
import { dollarsText, parseDollars, parseWholeNumber } from "@/domain/catalog-edit";
import { editProductAction } from "./actions";

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
const yesNo = { editable: true, cellEditor: "agSelectCellEditor", cellEditorParams: { values: ["Yes", "No"] } } as const;

// Double-click or press Enter on a cell to change it. The SKU, what is held and what is available are not editable.
const columns: ColDef<ProductRow>[] = [
  { field: "sku", headerName: "SKU", cellClass: "font-mono text-xs", minWidth: 150 },
  { field: "name", headerName: "Name", minWidth: 170, editable: true },
  { field: "category", headerName: "Category", editable: true },
  // Typed and shown in dollars; stored as whole cents. The edit box starts from plain dollars ("13.00").
  { field: "priceMinor", headerName: "Price", valueGetter: (p) => dollarsText(p.data?.priceMinor ?? 0), valueFormatter: (p) => `$${p.value}`, comparator: (a, b) => Number(a) - Number(b), editable: true, ...number },
  { field: "isFood", headerName: "Food", valueGetter: (p) => (p.data?.isFood ? "Yes" : "No"), ...yesNo },
  { field: "active", headerName: "Active", valueGetter: (p) => (p.data?.active ? "Yes" : "No"), ...yesNo },
  { field: "onHand", headerName: "On hand", editable: true, ...number },
  { field: "held", headerName: "Held", ...number },
  // Last on purpose: what can be sold now (on hand minus held).
  { field: "available", headerName: "Available", ...number },
];

const BAD_VALUE: Record<string, string> = {
  priceMinor: "Enter the price in dollars and cents, like 12.50.",
  onHand: "Enter how many you have as a whole number, like 40.",
  name: "A name is needed.",
  category: "A category is needed.",
};

/** The shop's products as a grid: change a name, category, price, food, active or stock in place. A refusal says why and leaves the row as it was. */
export function CatalogGrid({ rows }: { rows: ProductRow[] }) {
  return (
    <DataGrid<ProductRow>
      label="Products"
      searchLabel="Search products"
      rows={rows}
      columns={columns}
      emptyText="No products yet."
      onEdit={async ({ row, field, value }) => {
        let patch: Record<string, unknown>;
        let local: Partial<ProductRow>;
        switch (field) {
          case "name":
          case "category": {
            const text = typeof value === "string" ? value.trim() : "";
            if (!text) return { ok: false, message: BAD_VALUE[field]! };
            patch = { [field]: text };
            local = { [field]: text };
            break;
          }
          case "priceMinor": {
            const minor = parseDollars(value);
            if (minor === null) return { ok: false, message: BAD_VALUE.priceMinor! };
            patch = { priceMinor: minor };
            local = { priceMinor: minor };
            break;
          }
          case "isFood":
          case "active": {
            if (value !== "Yes" && value !== "No") return { ok: false, message: "Choose Yes or No." };
            patch = { [field]: value === "Yes" };
            local = { [field]: value === "Yes" };
            break;
          }
          case "onHand": {
            const n = parseWholeNumber(value);
            if (n === null) return { ok: false, message: BAD_VALUE.onHand! };
            patch = { onHand: n };
            local = { onHand: n, available: n - row.held };
            break;
          }
          default:
            return { ok: false, message: "That cannot be changed here." };
        }
        const outcome = await editProductAction(row.id, patch);
        return outcome.ok ? { ok: true, patch: local } : outcome;
      }}
    />
  );
}
