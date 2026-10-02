import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { AlertTriangle, Plus } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, EmptyState, CopyButton, PageHeader } from "../../components/page";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Sheet,
  SheetContent,
} from "../../components/ui/sheet";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { api } from "../../lib/api";
import { formatDate, formatUsdMicroPer1m } from "../../lib/format";
import {
  AdminGate,
  type AdminModel,
  parseCapabilities,
  usdPer1mToMicro,
  useAdminQuery,
} from "./shared";

// Matches backend PUBLIC_ID_RE: '<provider>/<name>' lowercase slug chars.
const PUBLIC_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

const schema = z.object({
  public_id: z.string().regex(PUBLIC_ID_RE, "Must be 'provider/name' of lowercase slug chars"),
  display_name: z.string().min(1, "Required"),
  provider: z.string().min(1, "Required"),
  description: z.string().optional(),
  capabilities: z.string().optional(), // comma-separated
  context_window: z.string().optional(), // empty = null
  enabled: z.boolean(),
  published: z.boolean(),
});
type Values = z.infer<typeof schema>;

/** Price history row from GET /models/:id/prices. */
interface PriceRow {
  id: string;
  effective_at: number;
  input_usd_micro_per_1m: number;
  output_usd_micro_per_1m: number;
  cached_input_usd_micro_per_1m: number;
  reasoning_usd_micro_per_1m: number;
  markup_ppm: number;
  current: boolean;
}

/** Mapping row from GET /models/:id/mappings; id may be absent on older API. */
interface MappingRow {
  id?: string;
  provider: string;
  upstream_model: string;
  enabled: number;
  created_at: number;
}

const PRICE_COLUMNS: ColumnDef<PriceRow, unknown>[] = [
  {
    header: "Effective at",
    accessorKey: "effective_at",
    cell: (c) => formatDate(c.getValue() as number),
  },
  {
    header: "Input",
    accessorKey: "input_usd_micro_per_1m",
    cell: (c) => formatUsdMicroPer1m(c.getValue() as number),
  },
  {
    header: "Output",
    accessorKey: "output_usd_micro_per_1m",
    cell: (c) => formatUsdMicroPer1m(c.getValue() as number),
  },
  {
    header: "Cached input",
    accessorKey: "cached_input_usd_micro_per_1m",
    cell: (c) => formatUsdMicroPer1m(c.getValue() as number),
  },
  {
    header: "Reasoning",
    accessorKey: "reasoning_usd_micro_per_1m",
    cell: (c) => formatUsdMicroPer1m(c.getValue() as number),
  },
  {
    header: "Markup",
    accessorKey: "markup_ppm",
    cell: (c) => `${((c.getValue() as number) / 1_000_000).toFixed(2)}×`,
  },
  {
    id: "current",
    header: "",
    cell: ({ row }) => (row.original.current ? <Badge>current</Badge> : null),
  },
];

/** Add-price form shared by the model sheet and the standalone Pricing page. */
export function AddPriceFields({
  modelId,
  onDone,
  onOpenChange,
}: {
  modelId: string;
  onDone: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [usd, setUsd] = useState<Record<string, string>>({});
  const qc = useQueryClient();
  // Markup entered as a multiple (1 = sell at cost). 1,000,000 ppm = 1×.
  // 0 markup would make every gateway request fail (positive charge cap).
  const [markupX, setMarkupX] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const PRICE_INPUTS = [
    { key: "input_usd_micro_per_1m", label: "Input USD / 1M tokens" },
    { key: "output_usd_micro_per_1m", label: "Output USD / 1M tokens" },
    { key: "cached_input_usd_micro_per_1m", label: "Cached input USD / 1M tokens" },
    { key: "reasoning_usd_micro_per_1m", label: "Reasoning USD / 1M tokens" },
  ] as const;

  const mutation = useMutation({
    mutationFn: () => {
      const body: Record<string, number> = {};
      for (const f of PRICE_INPUTS) {
        const micro = usdPer1mToMicro(usd[f.key] ?? "");
        if (micro === null) throw new Error(`${f.label}: enter a USD amount with up to 6 decimals`);
        body[f.key] = micro;
      }
      const ppm = usdPer1mToMicro(markupX);
      if (ppm === null) throw new Error("Markup must be a number like 1 or 1.25");
      body.markup_ppm = ppm;
      return api(`/api/v1/admin/catalog/models/${modelId}/prices`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      toast("Price row added");
      void qc.invalidateQueries({ queryKey: ["admin", "prices", modelId] });
      void qc.invalidateQueries({ queryKey: ["admin", "models"] });
      setUsd({});
      setMarkupX("1");
      setError(null);
      onDone();
      onOpenChange?.(false);
    },
    onError: (e) => setError(e.message),
  });

  return (
    <form
      id={`add-price-${modelId}`}
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      {PRICE_INPUTS.map((f) => (
        <div key={f.key} className="grid gap-1.5">
          <Label htmlFor={`${f.key}-${modelId}`}>{f.label}</Label>
          <Input
            id={`${f.key}-${modelId}`}
            className="font-mono"
            inputMode="decimal"
            placeholder="0.001500"
            value={usd[f.key] ?? ""}
            onChange={(e) => setUsd((s) => ({ ...s, [f.key]: e.target.value }))}
          />
        </div>
      ))}
      <div className="grid gap-1.5">
        <Label htmlFor={`markup-${modelId}`}>Markup (×)</Label>
        <Input
          id={`markup-${modelId}`}
          className="font-mono"
          inputMode="decimal"
          value={markupX}
          onChange={(e) => setMarkupX(e.target.value)}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div>
        <Button type="submit" size="sm" disabled={mutation.isPending}>
          Add price
        </Button>
      </div>
    </form>
  );
}

function PriceHistorySection({ model }: { model: AdminModel }) {
  const prices = useAdminQuery<PriceRow[]>(
    ["admin", "prices", model.id],
    `/api/v1/admin/catalog/models/${model.id}/prices`,
  );
  return (
    <div className="space-y-3">
      <AdminGate query={prices}>
        <DataTable
          columns={PRICE_COLUMNS}
          data={prices.data ?? []}
          empty="No price rows yet."
        />
      </AdminGate>
      <h3 className="text-sm font-medium">Add price</h3>
      <AddPriceFields modelId={model.id} onDone={() => {}} />
    </div>
  );
}

function RoutingSection({ model }: { model: AdminModel }) {
  const qc = useQueryClient();
  const mappings = useAdminQuery<MappingRow[]>(
    ["admin", "mappings", model.id],
    `/api/v1/admin/catalog/models/${model.id}/mappings`,
  );
  const cpaModels = useAdminQuery<{ data: { id: string }[] }>(
    ["admin", "cpa-models"],
    "/api/v1/admin/cpa/models",
  );
  const cpaIds = (cpaModels.data?.data ?? []).map((m) => m.id);
  const rows = mappings.data ?? [];
  const enabled = rows.filter((r) => r.enabled === 1);
  const history = rows.filter((r) => r.enabled !== 1);
  const current = enabled[0] ?? null;
  const [provider, setProvider] = useState(current?.provider ?? "");
  const [upstreamModel, setUpstreamModel] = useState(current?.upstream_model ?? "");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["admin", "mappings", model.id] });
    void qc.invalidateQueries({ queryKey: ["admin", "models"] });
  };

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/admin/catalog/models/${model.id}/route`, {
        method: "PUT",
        body: JSON.stringify({
          ...(provider.trim() ? { provider: provider.trim() } : {}),
          upstream_model: upstreamModel.trim(),
        }),
      }),
    onSuccess: () => {
      toast("Route saved");
      setError(null);
      invalidate();
    },
    onError: (e) => setError(e.message),
  });

  // Data cleanup for pre-existing multi-route models: keep only the picked one.
  const keep = useMutation({
    mutationFn: (row: MappingRow) =>
      api(`/api/v1/admin/catalog/models/${model.id}/route`, {
        method: "PUT",
        body: JSON.stringify({ provider: row.provider, upstream_model: row.upstream_model }),
      }),
    onSuccess: () => {
      toast("Route saved");
      invalidate();
    },
    onError: (e) => toast(e.message),
  });

  if (mappings.isLoading) return null;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Each model routes to one CPA model. CPA handles provider fallback and load balancing.
      </p>
      {enabled.length > 1 && (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
          <p className="flex items-center gap-1 font-medium text-destructive">
            <AlertTriangle className="size-3" /> Multiple active routes — only the oldest is used
          </p>
          <div className="mt-2 space-y-1">
            {enabled.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs">
                  {r.upstream_model} ({r.provider})
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={keep.isPending}
                  onClick={() => keep.mutate(r)}
                >
                  Keep this one
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      <AdminGate query={mappings}>
        <form
          className="grid gap-3 rounded-md border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <p className="text-sm font-medium">Route</p>
          <div className="grid gap-1.5">
            <Label htmlFor={`upstream-${model.id}`}>Upstream model (sent to CPA)</Label>
            <Input
              id={`upstream-${model.id}`}
              className="font-mono"
              list={`cpa-models-${model.id}`}
              placeholder="z-ai/glm-5.3-flash"
              value={upstreamModel}
              onChange={(e) => setUpstreamModel(e.target.value)}
              required
            />
            <datalist id={`cpa-models-${model.id}`}>
              {cpaIds.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            {upstreamModel.trim() && cpaIds.length > 0 && !cpaIds.includes(upstreamModel.trim()) && (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle className="size-3" /> Not in CPA&apos;s model list
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`provider-${model.id}`}>Provider label (optional)</Label>
            <Input
              id={`provider-${model.id}`}
              className="font-mono"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Label only — requests always go to CPA.
            </p>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div>
            <Button type="submit" size="sm" disabled={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      </AdminGate>
      {history.length > 0 && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setHistoryOpen((v) => !v)}
          >
            {historyOpen ? "Hide" : "Show"} route history ({history.length})
          </Button>
          {historyOpen && (
            <DataTable
              columns={[
                {
                  header: "Upstream model",
                  accessorKey: "upstream_model",
                  cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span>,
                },
                { header: "Label", accessorKey: "provider" },
                {
                  header: "Added",
                  accessorKey: "created_at",
                  cell: (c) => formatDate(c.getValue() as number),
                },
                { id: "enabled", header: "Enabled", cell: () => "No" },
              ]}
              data={history}
              empty=""
            />
          )}
        </div>
      )}
    </div>
  );
}

function DetailsSection({
  model,
  onSaved,
}: {
  model: AdminModel;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      public_id: model.public_id,
      display_name: model.display_name,
      provider: model.provider,
      description: model.description ?? "",
      capabilities: model.capabilities ? JSON.parse(model.capabilities).join(", ") : "",
      context_window: model.context_window == null ? "" : String(model.context_window),
      enabled: model.enabled === 1,
      published: model.published === 1,
    },
  });

  const mutation = useMutation({
    mutationFn: (v: Values) => {
      const ctx_window = v.context_window?.trim() ? Number(v.context_window) : null;
      if (ctx_window !== null && (!Number.isSafeInteger(ctx_window) || ctx_window <= 0))
        throw new Error("Context window must be a positive integer");
      return api(`/api/v1/admin/catalog/models/${model.id}`, {
        method: "PUT",
        body: JSON.stringify({
          slug: v.public_id.split("/")[1],
          display_name: v.display_name,
          provider: v.provider,
          description: v.description || null,
          capabilities: parseCapabilities(v.capabilities ?? ""),
          context_window: ctx_window,
          enabled: v.enabled,
          published: v.published,
        }),
      });
    },
    onSuccess: () => {
      toast("Model updated");
      void qc.invalidateQueries({ queryKey: ["admin", "models"] });
      onSaved();
    },
    onError: (e) => form.setError("root", { message: e.message }),
  });

  return (
    <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="display_name">Display name</Label>
        <Input id="display_name" {...form.register("display_name")} />
        {form.formState.errors.display_name && (
          <p className="text-xs text-destructive">
            {form.formState.errors.display_name.message}
          </p>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="provider">Vendor (shown to users)</Label>
        <Input id="provider" className="font-mono" {...form.register("provider")} />
        {form.formState.errors.provider && (
          <p className="text-xs text-destructive">{form.formState.errors.provider.message}</p>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" rows={2} {...form.register("description")} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="capabilities">Capabilities (comma-separated)</Label>
        <Input
          id="capabilities"
          placeholder="chat, tools, vision"
          {...form.register("capabilities")}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="context_window">Context window</Label>
        <Input id="context_window" type="number" min={1} {...form.register("context_window")} />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="enabled">Enabled</Label>
        <Switch
          id="enabled"
          checked={form.watch("enabled")}
          onCheckedChange={(c) => form.setValue("enabled", c)}
        />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="published">Published</Label>
        <Switch
          id="published"
          checked={form.watch("published")}
          onCheckedChange={(c) => form.setValue("published", c)}
        />
      </div>
      {form.formState.errors.root && (
        <p className="text-xs text-destructive">{form.formState.errors.root.message}</p>
      )}
      <div>
        <Button type="submit" disabled={mutation.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

function ModelSheet({
  model,
  open,
  onOpenChange,
}: {
  model: AdminModel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [section, setSection] = useState<"details" | "routing" | "pricing">("details");
  const tabs = [
    ["details", "Details"],
    ["routing", "Routing"],
    ["pricing", "Pricing"],
  ] as const;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full max-w-xl overflow-y-auto">
        <h2 className="flex items-center gap-1 font-mono text-sm font-medium">
          {model.public_id}
          <CopyButton value={model.public_id} label="Copy public ID" />
        </h2>
        <div className="flex gap-1" role="tablist" aria-label="Model sections">
          {tabs.map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={section === key ? "default" : "ghost"}
              onClick={() => setSection(key)}
            >
              {label}
            </Button>
          ))}
        </div>
        {section === "details" && <DetailsSection model={model} onSaved={() => {}} />}
        {section === "routing" && <RoutingSection model={model} />}
        {section === "pricing" && <PriceHistorySection model={model} />}
      </SheetContent>
    </Sheet>
  );
}

function CreateModelDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      public_id: "",
      display_name: "",
      provider: "",
      description: "",
      capabilities: "",
      context_window: "",
      enabled: true,
      published: false,
    },
  });

  const mutation = useMutation({
    mutationFn: (v: Values) => {
      const ctx_window = v.context_window?.trim() ? Number(v.context_window) : null;
      if (ctx_window !== null && (!Number.isSafeInteger(ctx_window) || ctx_window <= 0))
        throw new Error("Context window must be a positive integer");
      return api("/api/v1/admin/catalog/models", {
        method: "POST",
        body: JSON.stringify({
          public_id: v.public_id,
          slug: v.public_id.split("/")[1],
          display_name: v.display_name,
          provider: v.provider,
          description: v.description || null,
          capabilities: parseCapabilities(v.capabilities ?? ""),
          context_window: ctx_window,
          enabled: v.enabled,
          published: v.published,
        }),
      });
    },
    onSuccess: () => {
      toast("Model created");
      void qc.invalidateQueries({ queryKey: ["admin", "models"] });
      onOpenChange(false);
    },
    onError: (e) => form.setError("root", { message: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create model</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="public_id">Public ID (what clients send)</Label>
            <Input
              id="public_id"
              className="font-mono"
              placeholder="hoborouter/auto"
              {...form.register("public_id")}
            />
            {form.formState.errors.public_id && (
              <p className="text-xs text-destructive">{form.formState.errors.public_id.message}</p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="display_name">Display name</Label>
            <Input id="display_name" {...form.register("display_name")} />
            {form.formState.errors.display_name && (
              <p className="text-xs text-destructive">
                {form.formState.errors.display_name.message}
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="provider">Vendor (shown to users)</Label>
            <Input id="provider" className="font-mono" {...form.register("provider")} />
            {form.formState.errors.provider && (
              <p className="text-xs text-destructive">{form.formState.errors.provider.message}</p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" rows={2} {...form.register("description")} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="capabilities">Capabilities (comma-separated)</Label>
            <Input
              id="capabilities"
              placeholder="chat, tools, vision"
              {...form.register("capabilities")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="context_window">Context window</Label>
            <Input id="context_window" type="number" min={1} {...form.register("context_window")} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="enabled">Enabled</Label>
            <Switch
              id="enabled"
              checked={form.watch("enabled")}
              onCheckedChange={(c) => form.setValue("enabled", c)}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="published">Published</Label>
            <Switch
              id="published"
              checked={form.watch("published")}
              onCheckedChange={(c) => form.setValue("published", c)}
            />
          </div>
          {form.formState.errors.root && (
            <p className="text-xs text-destructive">{form.formState.errors.root.message}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminModelsPage() {
  const query = useAdminQuery<AdminModel[]>(["admin", "models"], "/api/v1/admin/catalog/models");
  const cpaModels = useAdminQuery<{ data: { id: string }[] }>(
    ["admin", "cpa-models"],
    "/api/v1/admin/cpa/models",
  );
  const cpaIds = new Set((cpaModels.data?.data ?? []).map((m) => m.id));
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<AdminModel | null>(null);
  // Keep the sheet contents stable while it is open (list refetches swap objects).
  const sheetModel = selected ? (query.data ?? []).find((m) => m.id === selected.id) ?? selected : null;

  const columns: ColumnDef<AdminModel, unknown>[] = [
    {
      id: "public_id",
      header: "Public ID",
      accessorFn: (m) => m.public_id,
      cell: ({ row }) => (
        <span className="flex flex-col">
          <span className="flex items-center gap-1 font-mono text-xs">
            {row.original.public_id}
            <CopyButton value={row.original.public_id} label="Copy public ID" />
          </span>
          <span className="text-xs text-muted-foreground">{row.original.display_name}</span>
        </span>
      ),
    },
    {
      id: "routes_to",
      header: "Routes to",
      cell: ({ row }) => {
        const m = row.original;
        const upstream = m.mapping?.upstream_model;
        const unknown = upstream !== undefined && cpaIds.size > 0 && !cpaIds.has(upstream);
        return (
          <span className="flex items-center gap-1 font-mono text-xs">
            {upstream ?? <span className="text-muted-foreground">No mapping</span>}
            {unknown && (
              <span title="Not in CPA's model list">
                <AlertTriangle className="size-3.5 text-destructive" />
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: "price",
      header: "Price (in / out per 1M)",
      cell: ({ row }) => {
        const p = row.original.current_price;
        return p ? (
          <span className="font-mono text-xs">
            {formatUsdMicroPer1m(p.input_usd_micro_per_1m)} /{" "}
            {formatUsdMicroPer1m(p.output_usd_micro_per_1m)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No price</span>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => {
        const m = row.original;
        // SAFETY: older API responses sent listed as 1/0; accept both shapes.
        const listed = m.listed === true || (m.listed as unknown as number) === 1;
        const hiddenText: Record<NonNullable<AdminModel["hidden_reason"]>, string> = {
          disabled: "Hidden: disabled",
          not_published: "Hidden: not published",
          missing_mapping: "Hidden: missing route",
          missing_price: "Hidden: missing price",
        };
        const hidden = listed
          ? null
          : m.hidden_reason != null
            ? (hiddenText[m.hidden_reason] ?? `Hidden: ${m.hidden_reason}`)
            : "Hidden";
        return (
          <Badge variant={hidden ? "secondary" : "default"}>{hidden ?? "Listed"}</Badge>
        );
      },
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSelected(row.original)}
        >
          Open
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Models"
        description="Catalog models for this instance."
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> Create model
          </Button>
        }
      />
      <AdminGate query={query}>
        {query.data && query.data.length === 0 ? (
          <EmptyState title="No models" description="Create the first catalog model." />
        ) : (
          <DataTable columns={columns} data={query.data ?? []} empty="No models match" />
        )}
      </AdminGate>
      <CreateModelDialog open={createOpen} onOpenChange={setCreateOpen} />
      {sheetModel && (
        <ModelSheet
          model={sheetModel}
          open={!!selected}
          onOpenChange={(o) => !o && setSelected(null)}
        />
      )}
    </div>
  );
}
