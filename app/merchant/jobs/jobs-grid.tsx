"use client";

import type { ColDef } from "ag-grid-community";
import type { ReactNode } from "react";
import { DataGrid } from "@/components/data-grid";
import { cents, format } from "@/lib/money";

export type JobGridRow = { id: string; request: string; boxes: number; status: string; readyBy: string; paidMinor: number };

const columns: ColDef<JobGridRow>[] = [
  { field: "request", headerName: "Request", minWidth: 120 },
  { field: "boxes", headerName: "Boxes", type: "numericColumn", filter: "agNumberColumnFilter", minWidth: 90 },
  { field: "status", headerName: "Status", minWidth: 150 },
  { field: "readyBy", headerName: "Ready by", minWidth: 130 },
  { field: "paidMinor", headerName: "Paid", type: "numericColumn", filter: "agNumberColumnFilter", valueFormatter: (p) => format(cents(p.value as number)), minWidth: 110 },
];

/** One section of jobs as a grid; choosing a row opens that job's pick list, history and moves below. */
export function JobsGrid({ label, emptyText, rows, details }: { label: string; emptyText: string; rows: JobGridRow[]; details: Record<string, ReactNode> }) {
  return <DataGrid<JobGridRow> label={label} searchLabel={`Search ${label.toLowerCase()}`} rows={rows} columns={columns} emptyText={emptyText} details={details} detailLabel={(r) => `Job for request ${r.request}`} />;
}
