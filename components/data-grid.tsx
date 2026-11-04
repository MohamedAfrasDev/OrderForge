"use client";

import {
  CellStyleModule,
  ClientSideRowModelModule,
  ColumnAutoSizeModule,
  ModuleRegistry,
  NumberFilterModule,
  QuickFilterModule,
  RowStyleModule,
  SelectEditorModule,
  TextEditorModule,
  TextFilterModule,
  ValidationModule,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// AG Grid Community only (MIT, no licence key, no Enterprise feature). Only the modules a grid here uses are registered, so the
// shop pages carry nothing more, and this file is imported by shop pages only: no customer route loads any of it.
ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  QuickFilterModule,
  TextFilterModule,
  NumberFilterModule,
  ColumnAutoSizeModule,
  CellStyleModule,
  RowStyleModule,
  TextEditorModule,
  SelectEditorModule,
  // Names a module a grid needs but this list lacks. Development only.
  ...(process.env.NODE_ENV === "production" ? [] : [ValidationModule]),
]);

const NO_PATCHES: Record<string, never> = {};

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
  /**
   * The detail-area pattern: what to show below the grid for each row, by row id, built on the server. A click (or Enter on a focused cell)
   * selects a row and opens its detail; the first row is open to begin with. All details are rendered by the server and handed over whole,
   * so nothing is fetched when a row is chosen.
   */
  details?: Record<string, ReactNode>;
  /** The accessible name of the detail area, given the selected row. */
  detailLabel?: (row: T) => string;
  /**
   * Makes the columns marked `editable` editable in place. The grid never changes its own data: a finished edit is handed to this function,
   * which saves it on the server. When it answers `ok`, the row shows the new values it returns; when it refuses, the row stays as it was and
   * the reason is shown above the grid. The value is what was typed (a string), or null if the cell was cleared.
   */
  onEdit?: (edit: { row: T; field: string; value: unknown }) => Promise<{ ok: true; patch: Partial<T> } | { ok: false; message: string }>;
};

/**
 * A data grid for the shop's lists: sortable columns, an optional search box, keyboard movement, and a theme from the app's colours.
 * Plain data in, nothing fetched here. The grid scrolls inside itself, so a narrow screen never makes the page scroll sideways.
 */
export function DataGrid<T extends { id: string }>({ label, rows, columns, searchLabel, emptyText, details, detailLabel, onEdit }: DataGridProps<T>) {
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  // What the server confirmed for edited rows, shown until fresh rows arrive from the page.
  const [saved, setSaved] = useState<{ source: T[]; patches: Record<string, Partial<T>> }>({ source: rows, patches: {} });
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const patches = saved.source === rows ? saved.patches : NO_PATCHES;
  const shown = useMemo(() => (Object.keys(patches).length === 0 ? rows : rows.map((r) => (patches[r.id] ? { ...r, ...patches[r.id] } : r))), [rows, patches]);
  // The chosen row if it still exists, else the first row: a refresh that removes a row never leaves the detail area blank.
  const selectedId = details ? (shown.some((r) => r.id === chosen) ? chosen : (shown[0]?.id ?? null)) : null;
  const selectedRow = shown.find((r) => r.id === selectedId);
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
      {editMessage ? (
        <p role="alert" data-testid="grid-edit-message" className="rounded-lg border border-destructive p-2 text-sm text-destructive">
          {editMessage}
        </p>
      ) : null}
      <div ref={wrapper} className="min-w-0 overflow-hidden">
        <AgGridReact<T>
          theme={theme}
          rowData={shown}
          columnDefs={columns}
          defaultColDef={defaultColDef}
          getRowId={(params: GetRowIdParams<T>) => params.data.id}
          quickFilterText={search}
          domLayout="autoHeight"
          animateRows={false}
          readOnlyEdit={onEdit ? true : undefined}
          onCellEditRequest={
            onEdit
              ? async (event) => {
                  const field = event.colDef.field;
                  if (!field || !event.data) return;
                  setEditMessage(null);
                  const result = await onEdit({ row: event.data, field, value: event.newValue });
                  if (!result.ok) return setEditMessage(result.message);
                  setSaved((now) => ({ source: rows, patches: { ...(now.source === rows ? now.patches : {}), [event.data!.id]: { ...(now.source === rows ? now.patches[event.data!.id] : {}), ...result.patch } } }));
                }
              : undefined
          }
          getRowStyle={
            details
              ? (params) => ({ cursor: "pointer", ...(params.data?.id === selectedId ? { backgroundColor: "var(--accent)" } : {}) })
              : undefined
          }
          onRowClicked={details ? (event) => event.data && setChosen(event.data.id) : undefined}
          onCellKeyDown={
            details
              ? (event) => {
                  const key = (event.event as KeyboardEvent | null)?.key;
                  if (event.data && (key === "Enter" || key === " ")) setChosen(event.data.id);
                }
              : undefined
          }
        />
      </div>
      {details && selectedRow ? (
        <section aria-label={detailLabel ? detailLabel(selectedRow) : "Details"} data-testid="grid-detail" className="min-w-0">
          {details[selectedRow.id]}
        </section>
      ) : null}
    </div>
  );
}
