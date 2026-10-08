import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, Check, Copy, Inbox, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-12 text-center">
      {Icon && <Icon className="size-6 text-muted-foreground/60" aria-hidden />}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {children}
    </div>
  );
}

export function ErrorState({ message }: { message?: string }) {
  return (
    <div className="rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      {message ?? "Something went wrong."}
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      // Hit area 44px on touch; the glyph itself stays small.
      className="size-6 pointer-coarse:size-11"
      aria-label={label ?? "Copy"}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        toast("Copied");
      }}
    >
      <Copy className="size-3.5" />
    </Button>
  );
}

interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  globalFilter?: string;
  onGlobalFilterChange?: (value: string) => void;
  empty?: React.ReactNode;
  /**
   * When set, the table itself is wrapped in a bounded ScrollPanel so long
   * lists scroll inside the panel (sticky header) instead of growing the
   * page. The search input stays above the region. Omit when the caller
   * already wraps the DataTable in a ScrollPanel.
   */
  scroll?: { label: string };
}

/** Generic TanStack Table wrapper: sorting + optional external global filter. */
export function DataTable<TData>({
  columns,
  data,
  globalFilter,
  onGlobalFilterChange,
  empty,
  scroll,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: (updater) => {
      if (onGlobalFilterChange)
        onGlobalFilterChange(typeof updater === "function" ? updater(globalFilter ?? "") : updater);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const tableEl = (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((hg) => (
          <TableRow key={hg.id}>
            {hg.headers.map((header) => (
              <TableHead key={header.id} className={cn(header.column.columnDef.meta as string)}>
                {/* header mirrors the cell meta string (e.g. responsive hide classes) */}
                {header.isPlaceholder ? null : header.column.getCanSort() ? (
                  <button
                    // Negative margins extend the tap target to ~44px
                    // without changing the header row's visual height.
                    className="-mx-1 -my-3 flex items-center gap-1 px-1 py-3 hover:text-foreground"
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {header.column.getIsSorted() === "asc" && <ArrowUp className="size-3" />}
                    {header.column.getIsSorted() === "desc" && <ArrowDown className="size-3" />}
                  </button>
                ) : (
                  flexRender(header.column.columnDef.header, header.getContext())
                )}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="p-0 text-center text-muted-foreground">
              <div className="py-2">
                <EmptyState icon={Inbox} title={typeof empty === "string" ? empty : "No data"} />
              </div>
            </TableCell>
          </TableRow>
        ) : (
          table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} className={cn(cell.column.columnDef.meta as string)}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );

  return (
    <div>
      {onGlobalFilterChange && (
        <Input
          placeholder="Search…"
          value={globalFilter ?? ""}
          onChange={(e) => onGlobalFilterChange(e.target.value)}
          className="mb-2 max-w-64"
        />
      )}
      {scroll ? (
        <ScrollPanel label={scroll.label} stickyHeader>
          {tableEl}
        </ScrollPanel>
      ) : (
        tableEl
      )}
    </div>
  );
}

export { Check };

/**
 * Bounded-height scroll container: long tables scroll inside their panel
 * instead of growing the whole page. Exposed as a labelled region and
 * keyboard-scrollable (tabIndex) per WCAG 2.1.1; stickyHeader keeps the
 * table header visible while rows scroll.
 */
export function ScrollPanel({
  label,
  children,
  stickyHeader,
  className,
}: {
  label: string;
  children: React.ReactNode;
  stickyHeader?: boolean;
  className?: string;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        "max-h-96 overflow-auto overscroll-contain rounded-lg border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        stickyHeader && "[&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-background",
        className,
      )}
    >
      {children}
    </div>
  );
}
