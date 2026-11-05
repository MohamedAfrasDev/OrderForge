"use client";

import type { ColDef } from "ag-grid-community";
import type { ReactNode } from "react";
import { DataGrid } from "@/components/data-grid";
import { cents, format } from "@/lib/money";

export type DraftGridRow = { id: string; request: string; version: number; totalMinor: number; needsDecision: string; created: string };

const columns: ColDef<DraftGridRow>[] = [
  { field: "request", headerName: "Request", minWidth: 120 },
  { field: "version", headerName: "Version", type: "numericColumn", filter: "agNumberColumnFilter", minWidth: 100 },
  { field: "totalMinor", headerName: "Total", type: "numericColumn", filter: "agNumberColumnFilter", valueFormatter: (p) => format(cents(p.value as number)), minWidth: 110 },
  { field: "needsDecision", headerName: "Needs your decision", minWidth: 170 },
  { field: "created", headerName: "Created", valueFormatter: (p) => `${String(p.value).slice(0, 16).replace("T", " ")} UTC`, minWidth: 170 },
];

/** Draft quotes waiting for the shop as a grid; choosing a row opens that draft with its publish and withdraw forms below. */
export function DraftsGrid({ rows, details }: { rows: DraftGridRow[]; details: Record<string, ReactNode> }) {
  return <DataGrid<DraftGridRow> label="Drafts" searchLabel="Search drafts" emptyText="Nothing is waiting for review." rows={rows} columns={columns} details={details} detailLabel={(r) => `Draft for request ${r.request}`} />;
}
