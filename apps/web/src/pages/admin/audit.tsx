import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
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
import { DataTable, PageHeader } from "../../components/page";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { formatDate, formatVnd } from "../../lib/format";
import { AdminGate, useAdminQuery } from "./shared";

/** Enriched audit row from GET /api/v1/audit (server resolves labels). */
export interface AuditEntry {
  id: string;
  actor_user_id: string | null;
  workspace_id: string | null;
  action: string;
  target: string | null;
  detail: string | null;
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
    ACTION_LABELS[action] ??
    (action.charAt(0).toUpperCase() + action.slice(1).replaceAll(".", " "))
  );
}

const MONEY_KEYS = /amount|price|charged|cost/i;

/** Detail JSON -> readable chips. Money values formatted, ids shortened. */
function detailChips(detail: string | null): Array<[string, string]> {
  if (!detail) return [];
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    obj = parsed as Record<string, unknown>;
  } catch {
    return [[detail.slice(0, 64), ""]];
  }
  return Object.entries(obj).map(([k, v]) => {
    let text: string;
    if (typeof v === "number" && MONEY_KEYS.test(k)) text = formatVnd(v);
    else if (typeof v === "string" && v.length > 24) text = `${v.slice(0, 8)}…`;
    else text = typeof v === "object" ? JSON.stringify(v) : String(v);
    return [k, text];
  });
}

function initials(name?: string | null, email?: string | null): string {
  const s = name?.trim() || email?.split("@")[0] || "?";
  return s
    .split(/[\s._-]+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
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
function Hover({
  tip,
  children,
}: {
  tip: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

const typeBadge = (t: string) => t.replace(" ", "-");

const columns: ColumnDef<AuditEntry, unknown>[] = [
  {
    accessorKey: "created_at",
    header: "Time",
    cell: (c) => {
      const ms = c.getValue<number>();
      const iso = new Date(ms).toISOString();
      return (
        <Hover tip={<span className="font-mono">{iso} · {formatDate(ms)}</span>}>
          <span className="font-mono text-xs">{relativeTime(ms)}</span>
        </Hover>
      );
    },
  },
  {
    accessorKey: "action",
    header: "Action",
    cell: (c) => (
      <Hover tip={<span className="font-mono">{c.getValue<string>()}</span>}>
        <span className="text-xs">{humanizeAction(c.getValue<string>())}</span>
      </Hover>
    ),
  },
  {
    accessorKey: "actor",
    header: "Actor",
    cell: (c) => {
      const actor = c.getValue<AuditEntry["actor"]>();
      if (!actor)
        return <span className="font-mono text-xs text-muted-foreground">—</span>;
      const name = actor.name || actor.email || actor.id;
      return (
        <Hover
          tip={
            <div className="space-y-0.5">
              <div>{actor.name ?? "—"}</div>
              <div className="text-muted-foreground">{actor.email ?? "—"}</div>
              <div className="font-mono text-muted-foreground">{actor.id}</div>
            </div>
          }
        >
          <span className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded-full border border-border text-[9px] font-medium">
              {initials(actor.name, actor.email)}
            </span>
            <span className="text-xs">{name}</span>
            {actor.email && actor.email !== name && (
              <span className="text-xs text-muted-foreground">{actor.email}</span>
            )}
          </span>
        </Hover>
      );
    },
  },
  {
    accessorKey: "target",
    header: "Target",
    cell: ({ row }) => {
      const r = row.original;
      if (!r.target)
        return <span className="font-mono text-xs text-muted-foreground">—</span>;
      const label = r.target_label ?? r.target.slice(0, 8);
      const meta = r.target_meta;
      return (
        <Hover
          tip={
            <div className="space-y-0.5">
              <div className="font-mono">{r.target}</div>
              {r.target_type && <div className="text-muted-foreground">{r.target_type}</div>}
              {meta &&
                Object.entries(meta)
                  .filter(([k]) => k !== "id")
                  .map(([k, v]) => (
                    <div key={k} className="text-muted-foreground">
                      {k}: {String(v)}
                    </div>
                  ))}
            </div>
          }
        >
          <span className="flex items-center gap-1.5">
            {r.target_type && <Badge variant="outline">{typeBadge(r.target_type)}</Badge>}
            <span className="font-mono text-xs">{label}</span>
          </span>
        </Hover>
      );
    },
  },
  {
    accessorKey: "workspace",
    header: "Workspace",
    cell: (c) => {
      const ws = c.getValue<AuditEntry["workspace"]>();
      return <span className="text-xs">{ws?.name ?? "—"}</span>;
    },
  },
  {
    accessorKey: "detail",
    header: "Details",
    enableSorting: false,
    cell: ({ row }) => {
      const chips = detailChips(row.original.detail);
      if (chips.length === 0)
        return <span className="font-mono text-xs text-muted-foreground">—</span>;
      return (
        <span className="flex flex-wrap gap-1">
          {chips.map(([k, v]) => (
            <span
              key={k}
              className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]"
            >
              {v ? (
                <>
                  <span className="text-muted-foreground">{k}: </span>
                  {v}
                </>
              ) : (
                k
              )}
            </span>
          ))}
        </span>
      );
    },
  },
];

export default function AdminAuditPage() {
  const query = useAdminQuery<AuditEntry[]>(["admin", "audit"], "/api/v1/audit?limit=200");
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("all");

  const rows = query.data ?? [];
  const actions = useMemo(
    () => [...new Set(rows.map((r) => r.action))].sort(),
    [rows],
  );
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (actionFilter !== "all" && !r.action.startsWith(actionFilter)) return false;
      if (!s) return true;
      return [r.action, r.actor?.name, r.actor?.email, r.target_label, r.target, r.workspace?.name, r.detail]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(s));
    });
  }, [rows, search, actionFilter]);

  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" description="Actions taken across the instance." />
      <AdminGate query={query}>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-sm font-medium">Audit log</CardTitle>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 w-48 text-xs"
              />
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue placeholder="All actions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All actions</SelectItem>
                  {actions.map((a) => (
                    <SelectItem key={a} value={a}>
                      {humanizeAction(a)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            <DataTable columns={columns} data={filtered} empty="No audit entries" />
          </CardContent>
        </Card>
      </AdminGate>
    </div>
  );
}
