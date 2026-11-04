"use client";

import {
  CellStyleModule,
  ClientSideRowModelModule,
  ColumnAutoSizeModule,
  ModuleRegistry,
  NumberFilterModule,
  QuickFilterModule,
  TextFilterModule,
  ValidationModule,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useEffect, useMemo, useRef, useState } from "react";

// AG Grid Community only (MIT, no licence key, no Enterprise feature). Only the modules a grid here uses are registered, so the
// shop pages carry nothing more, and this file is imported by shop pages only: no customer route loads any of it.
ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  QuickFilterModule,
  TextFilterModule,
  NumberFilterModule,
  ColumnAutoSizeModule,
  CellStyleModule,
  // Names a module a grid needs but this list lacks. Development only.
  ...(process.env.NODE_ENV === "production" ? [] : [ValidationModule]),
]);

// The grid takes its colours from the app's own variables, so it follows the light and dark modes without a second palette.
const theme = themeQuartz.withParams({
  backgroundColor: "var(--card)",
  foregroundColor: "var(--foreground)",
  borderColor: "var(--border)",
  chromeBackgroundColor: "var(--muted)",
  headerBackgroundColor: "var(--muted)",
  headerTextColor: "var(--muted-foreground)",
  oddRowBackgroundColor: "transparent",
  accentColor: "var(--ring)",
  selectedRowBackgroundColor: "var(--accent)",
  fontFamily: "inherit",
  fontSize: 14,
  wrapperBorderRadius: 8,
  spacing: 6,
});

export type DataGridProps<T extends { id: string }> = {
  /** The accessible name of the grid, and the label of its search box when there is one. */
  label: string;
  rows: T[];
  columns: ColDef<T>[];
  /** Adds a search box above the grid that narrows the rows. */
  searchLabel?: string;
  /** Shown instead of an empty grid. */
  emptyText?: string;
};

/**
 * A data grid for the shop's lists: sortable columns, an optional search box, keyboard movement, and a theme from the app's colours.
 * Plain data in, nothing fetched here. The grid scrolls inside itself, so a narrow screen never makes the page scroll sideways.
 */
export function DataGrid<T extends { id: string }>({ label, rows, columns, searchLabel, emptyText }: DataGridProps<T>) {
  const [search, setSearch] = useState("");
  const wrapper = useRef<HTMLDivElement>(null);
  const defaultColDef = useMemo<ColDef<T>>(
    // No type guessing: a boolean is shown as the text the column's formatter gives, not as a checkbox.
    () => ({ sortable: true, resizable: false, flex: 1, minWidth: 110, cellDataType: false }),
    [],
  );

  // AG Grid builds the element with role "grid" itself; give it its name once it exists.
  useEffect(() => {
    const root = wrapper.current;
    if (!root) return;
    const name = () => root.querySelector("[role=grid]")?.setAttribute("aria-label", label);
    name();
    const observer = new MutationObserver(name);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [label]);

  if (rows.length === 0 && emptyText) return <p className="text-sm text-muted-foreground">{emptyText}</p>;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {searchLabel ? (
        <input
          type="search"
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-full max-w-xs rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm"
        />
      ) : null}
      <div ref={wrapper} className="min-w-0 overflow-hidden">
        <AgGridReact<T>
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={defaultColDef}
          getRowId={(params: GetRowIdParams<T>) => params.data.id}
          quickFilterText={search}
          domLayout="autoHeight"
          animateRows={false}
        />
      </div>
    </div>
  );
}
