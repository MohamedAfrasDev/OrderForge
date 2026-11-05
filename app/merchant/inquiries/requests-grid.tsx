"use client";

import type { ColDef } from "ag-grid-community";
import type { ReactNode } from "react";
import { DataGrid } from "@/components/data-grid";

export type RequestRow = {
  id: string;
  /** ISO time the request was handed over; the grid shows it as text and sorts by it. */
  handedOver: string;
  /** The customer's first message, shortened. */
  request: string;
  /** "Number of boxes" as the customer confirmed it, or an empty string. */
  boxes: string;
  /** Whether the last word was the shop's. */
  state: "Needs your reply" | "You replied";
};

const columns: ColDef<RequestRow>[] = [
  { field: "handedOver", headerName: "Handed over", valueFormatter: (p) => `${String(p.value).slice(0, 16).replace("T", " ")} UTC`, sort: "desc", flex: 0, minWidth: 170 },
  { field: "request", headerName: "Request", flex: 3, minWidth: 220 },
  { field: "boxes", headerName: "Boxes", flex: 0, minWidth: 90 },
  { field: "state", headerName: "Status", flex: 1, minWidth: 150, cellStyle: (p) => (p.value === "Needs your reply" ? { fontWeight: 600 } : null) },
];

/** The shop's requests, newest first; choosing a row opens that request's conversation, order so far and reply box below. */
export function RequestsGrid({ rows, details }: { rows: RequestRow[]; details: Record<string, ReactNode> }) {
  return (
    <DataGrid<RequestRow>
      label="Requests"
      rows={rows}
      columns={columns}
      searchLabel="Search requests"
      emptyText="No inquiries are waiting for you."
      details={details}
      detailLabel={(r) => `Request ${r.id.slice(0, 8)}`}
    />
  );
}
