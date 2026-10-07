import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { PageHeader } from "../../components/page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "../../components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { formatDate } from "../../lib/format";
import { AdminGate, useAdminQuery } from "./shared";
import { useT } from "../../lib/i18n/t";

// Audit log copy: inline LocaleEntry set (see lib/i18n/common.ts). Action
// names, actor/target identifiers and JSON details are never translated.
const auditCopy = {
  time: { en: "Time", vi: "Thời gian" },
  action: { en: "Action", vi: "Hành động" },
  actor: { en: "Actor", vi: "Người thực hiện" },
  target: { en: "Target", vi: "Đối tượng" },
  workspace: { en: "Workspace", vi: "Workspace" },
  details: { en: "Details", vi: "Chi tiết" },
  title: { en: "Audit log", vi: "Nhật ký kiểm toán" },
  description: {
    en: "Actions taken across the instance.",
    vi: "Các hành động thực hiện trên toàn instance.",
  },
  search: { en: "Search…", vi: "Tìm…" },
  allActions: { en: "All actions", vi: "Tất cả hành động" },
  noEntries: { en: "No audit entries", vi: "Không có mục kiểm toán" },
  eventAria: { en: "Audit event {action}", vi: "Sự kiện kiểm toán {action}" },
  detailsTitle: { en: "Audit event details", vi: "Chi tiết sự kiện kiểm toán" },
  eventId: { en: "Event ID", vi: "ID sự kiện" },
} as const;

/** Enriched audit row from GET /api/v1/audit (server resolves labels). */
export interface AuditEntry {
  id: string;
  actor_user_id: string | null;
  workspace_id: string | null;
  action: string;
  target: string | null;
  /** jsonb object from Postgres; legacy rows may still be a JSON string. */
  detail: unknown;
  created_at: number;
  actor: { id: string; name: string | null; email: string | null } | null;
  workspace: { id: string; name: string } | null;
  target_label: string | null;
  target_type: string | null;
  target_meta: Record<string, unknown> | null;
}

const ACTION_LABELS: Record<string, string> = {
  "workspace.create": "Workspace created",
  "workspace.rename": "Workspace renamed",
  "workspace.delete": "Workspace deleted",
  "key.create": "API key created",
  "key.enable": "API key enabled",
  "key.disable": "API key disabled",
  "key.revoke": "API key revoked",
  "key.models.set": "API key models set",
  "payment.create": "Payment created",
  "payment.dev_complete": "Payment completed (dev)",
  "payment.admin_complete": "Payment completed (admin)",
  "catalog.model.create": "Model created",
  "catalog.model.update": "Model updated",
  "catalog.mapping.create": "Mapping added",
  "catalog.mapping.update": "Mapping updated",
  "catalog.price.create": "Price added",
  "member.add": "Member added",
  "member.role_change": "Member role changed",
  "member.remove": "Member removed",
  "model.create": "Model created",
  "model.update": "Model updated",
};

function humanizeAction(action: string): string {
  return (
    ACTION_LABELS[action] ?? action.charAt(0).toUpperCase() + action.slice(1).replaceAll(".", " ")
  );
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Monochrome cell wrapper with a hover tooltip. */
function Hover({ tip, children }: { tip: React.ReactNode; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** One-line, truncating cell content. The table row is whitespace-nowrap. */
const truncate = "block max-w-full truncate";

type DetailView =
  | { kind: "object"; value: Record<string, unknown> }
  | { kind: "text"; value: string };

/** jsonb object (Postgres) or legacy JSON string -> object view, else plain text. */
function readDetail(detail: unknown): DetailView {
  let v = detail;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { kind: "text", value: v as string };
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v))
    return { kind: "object", value: v as Record<string, unknown> };
  return { kind: "text", value: typeof v === "string" ? v : JSON.stringify(v) };
}

const isEmptyDetail = (d: unknown) => d == null || d === "";

/** Detail -> compact one-line summary (first key: value pair, else raw). */
function detailSummary(detail: unknown): string {
  if (isEmptyDetail(detail)) return "—";
  const view = readDetail(detail);
  if (view.kind === "text") return view.value;
  const entries = Object.entries(view.value);
  const first = entries[0];
  if (!first) return "—";
  const [k, v] = first;
  const text = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  return entries.length > 1 ? `${k}: ${text} (+${entries.length - 1})` : `${k}: ${text}`;
}

/** Key/value line for the detail sheet. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="break-words font-mono text-xs">{children}</div>
    </div>
  );
}

const typeBadge = (t: string) => t.replace(" ", "-");

const auditColumns = (t: (k: keyof typeof auditCopy) => string): ColumnDef<AuditEntry, unknown>[] => [
  {
    accessorKey: "created_at",
    header: t("time"),
    cell: (c) => {
      const ms = c.getValue<number>();
      const iso = new Date(ms).toISOString();
      return (
        <Hover
          tip={
            <span className="font-mono">
              {iso} · {formatDate(ms)}
            </span>
          }
        >
          <span className={`${truncate} font-mono text-xs`}>{relativeTime(ms)}</span>
        </Hover>
      );
    },
  },
  {
    accessorKey: "action",
    header: t("action"),
    cell: (c) => (
      <Hover tip={<span className="font-mono">{c.getValue<string>()}</span>}>
        <span className={truncate}>{humanizeAction(c.getValue<string>())}</span>
      </Hover>
    ),
  },
  {
    accessorKey: "actor",
    header: t("actor"),
    cell: (c) => {
      const actor = c.getValue<AuditEntry["actor"]>();
      if (!actor?.email)
        return <span className={`${truncate} font-mono text-muted-foreground`}>—</span>;
      return (
        <Hover
          tip={
            <div className="space-y-0.5">
              <div>{actor.name ?? "—"}</div>
              <div>{actor.email}</div>
              <div className="font-mono text-muted-foreground">{actor.id}</div>
            </div>
          }
        >
          <span className={`${truncate} text-xs`}>{actor.email}</span>
        </Hover>
      );
    },
  },
  {
    accessorKey: "target",
    header: t("target"),
    cell: ({ row }) => {
      const r = row.original;
      if (!r.target)
        return <span className={`${truncate} font-mono text-muted-foreground`}>—</span>;
      const label = r.target_label ?? r.target.slice(0, 8);
      return (
        <Hover
          tip={
            <div className="space-y-0.5">
              <div className="font-mono">{r.target}</div>
              {r.target_type && <div className="text-muted-foreground">{r.target_type}</div>}
            </div>
          }
        >
          <span className={`${truncate} font-mono text-xs`}>
            {r.target_type && <Badge variant="outline">{typeBadge(r.target_type)}</Badge>} {label}
          </span>
        </Hover>
      );
    },
  },
  {
    accessorKey: "workspace",
    header: t("workspace"),
    cell: (c) => {
      const ws = c.getValue<AuditEntry["workspace"]>();
      return <span className={truncate}>{ws?.name ?? "—"}</span>;
    },
  },
  {
    accessorKey: "detail",
    header: t("details"),
    enableSorting: false,
    cell: ({ row }) => (
      <span className={`${truncate} font-mono text-xs text-muted-foreground`}>
        {detailSummary(row.original.detail)}
      </span>
    ),
  },
];


export default function AdminAuditPage() {
  const t = useT(auditCopy);
  const cols = auditColumns(t);
  const query = useAdminQuery<AuditEntry[]>(["admin", "audit"], "/api/v1/audit?limit=200");
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  const rows = query.data ?? [];
  const actions = useMemo(() => [...new Set(rows.map((r) => r.action))].sort(), [rows]);
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (actionFilter !== "all" && !r.action.startsWith(actionFilter)) return false;
      if (!s) return true;
      return [
        r.action,
        r.actor?.name,
        r.actor?.email,
        r.target_label,
        r.target,
        r.workspace?.name,
        detailSummary(r.detail),
      ]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(s));
    });
  }, [rows, search, actionFilter]);

  const table = useReactTable({
    data: filtered,
    columns: cols,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // 6rem = app shell header (h-12) + page padding (p-6 vertical). The list
  // scrolls inside this bound so 200 entries never grow the page.
  return (
    // min-h-0: on short landscape screens (100dvh-6rem < 320px) a fixed min-height
    // would force the outer overflow-hidden to clip the card; the inner scroller
    // keeps the list usable at any height.
    <div className="flex h-[calc(100dvh-6rem)] min-h-0 flex-col gap-4 overflow-hidden">
      <PageHeader title={t("title")} description={t("description")} />
      <AdminGate query={query}>
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="flex shrink-0 flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Input
                placeholder={t("search")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 w-full text-xs sm:w-48"
              />
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger className="h-8 w-40 flex-1 text-xs sm:w-40">
                  <SelectValue placeholder={t("allActions")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("allActions")}</SelectItem>
                  {actions.map((a) => (
                    <SelectItem key={a} value={a}>
                      {humanizeAction(a)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-hidden">
            <div className="h-full overflow-auto">
              <Table className="min-w-3xl">
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    {(table.getHeaderGroups()[0]?.headers ?? []).map((header) => (
                      <TableHead key={header.id}>
                        {header.column.getCanSort() ? (
                          <button
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {header.column.getIsSorted() === "asc" && <span aria-hidden>↑</span>}
                            {header.column.getIsSorted() === "desc" && <span aria-hidden>↓</span>}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {table.getRowModel().rows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={cols.length}
                        className="text-center text-muted-foreground"
                      >
                        {t("noEntries")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    table.getRowModel().rows.map((row) => {
                      const entry = row.original;
                      const open = () => setSelected(entry);
                      return (
                        <TableRow
                          key={row.id}
                          tabIndex={0}
                          role="button"
                          aria-haspopup="dialog"
                          aria-label={t("eventAria", { action: entry.action })}
                          onClick={open}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              open();
                            }
                          }}
                          className="cursor-pointer whitespace-nowrap focus:bg-muted/50 focus:outline-none"
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell key={cell.id} className="max-w-56">
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </AdminGate>

      <Sheet open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="overflow-y-auto">
          {selected && (
            <div className="space-y-4">
              <div>
                <SheetTitle>{humanizeAction(selected.action)}</SheetTitle>
                <SheetDescription>{t("detailsTitle")}</SheetDescription>
              </div>
              <div className="space-y-3">
                <Field label={t("time")}>
                  {formatDate(selected.created_at)} ({new Date(selected.created_at).toISOString()})
                </Field>
                <Field label={t("eventId")}>{selected.id}</Field>
                <Field label={t("action")}>{selected.action}</Field>
                <Field label={t("actor")}>
                  {selected.actor ? (
                    <>
                      <div>{selected.actor.name ?? "—"}</div>
                      <div>{selected.actor.email ?? "—"}</div>
                      <div>{selected.actor.id}</div>
                    </>
                  ) : (
                    "—"
                  )}
                </Field>
                <Field label={t("workspace")}>
                  {selected.workspace ? (
                    <>
                      {selected.workspace.name}
                      <div className="text-muted-foreground">{selected.workspace.id}</div>
                    </>
                  ) : (
                    "—"
                  )}
                </Field>
                <Field label={t("target")}>
                  {selected.target ? (
                    <>
                      {selected.target}
                      {selected.target_type && (
                        <div className="text-muted-foreground">{selected.target_type}</div>
                      )}
                      {selected.target_label && (
                        <div className="text-muted-foreground">{selected.target_label}</div>
                      )}
                      {selected.target_meta &&
                        Object.entries(selected.target_meta).map(([k, v]) => (
                          <div key={k} className="text-muted-foreground">
                            {k}: {String(v)}
                          </div>
                        ))}
                    </>
                  ) : (
                    "—"
                  )}
                </Field>
                <Field label={t("details")}>
                  {isEmptyDetail(selected.detail)
                    ? "—"
                    : (() => {
                        const view = readDetail(selected.detail);
                        return view.kind === "text"
                          ? view.value
                          : JSON.stringify(view.value, null, 2);
                      })()}
                </Field>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
