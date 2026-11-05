"use client";

import type { ColDef } from "ag-grid-community";
import type { ReactNode } from "react";
import { DataGrid } from "@/components/data-grid";
import { cents, format } from "@/lib/money";

export type DecisionGridRow = { id: string; request: string; version: number; totalMinor: number; since: string };

const columns: ColDef<DecisionGridRow>[] = [
  { field: "request", headerName: "Request", minWidth: 120 },
  { field: "version", headerName: "Quote version", type: "numericColumn", filter: "agNumberColumnFilter", minWidth: 120 },
  { field: "totalMinor", headerName: "Total", type: "numericColumn", filter: "agNumberColumnFilter", valueFormatter: (p) => format(cents(p.value as number)), minWidth: 120 },
  { field: "since", headerName: "Authorized", valueFormatter: (p) => (p.value ? `${String(p.value).slice(0, 16).replace("T", " ")} UTC` : ""), minWidth: 170 },
];

/** One section of orders as a grid; choosing a row opens that order's card (and its decision forms) below. */
export function DecisionsGrid({ label, emptyText, rows, details }: { label: string; emptyText: string; rows: DecisionGridRow[]; details: Record<string, ReactNode> }) {
  return <DataGrid<DecisionGridRow> label={label} searchLabel={`Search ${label.toLowerCase()}`} rows={rows} columns={columns} emptyText={emptyText} details={details} detailLabel={(r) => `Order for request ${r.request}`} />;
}
