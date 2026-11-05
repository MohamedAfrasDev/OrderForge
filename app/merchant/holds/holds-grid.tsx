"use client";

import type { ColDef } from "ag-grid-community";
import type { ReactNode } from "react";
import { DataGrid } from "@/components/data-grid";

export type HoldGridRow = { id: string; request: string; state: string; items: number; changed: string };

const columns: ColDef<HoldGridRow>[] = [
  { field: "request", headerName: "Request", minWidth: 120 },
  { field: "state", headerName: "State", minWidth: 190 },
  { field: "items", headerName: "Items", type: "numericColumn", filter: "agNumberColumnFilter", minWidth: 90 },
  { field: "changed", headerName: "Last change", valueFormatter: (p) => `${String(p.value).slice(0, 16).replace("T", " ")} UTC`, minWidth: 170 },
];

/** One section of stock holds as a grid; choosing a row shows what is held and why below. Read only. */
export function HoldsGrid({ label, emptyText, rows, details }: { label: string; emptyText: string; rows: HoldGridRow[]; details: Record<string, ReactNode> }) {
  return <DataGrid<HoldGridRow> label={label} searchLabel={`Search ${label.toLowerCase()}`} rows={rows} columns={columns} emptyText={emptyText} details={details} detailLabel={(r) => `Hold for request ${r.request}`} />;
}
