import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DataTable, EmptyState, PageHeader } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { api } from "../../lib/api";
import { formatDate } from "../../lib/format";
import { AdminGate, type AdminModel, useAdminQuery } from "./shared";

/** Mapping row from GET /models/:id/mappings; id may be absent on older API. */
interface MappingRow {
  id?: string;
  provider: string;
  upstream_model: string;
  enabled: number;
  created_at: number;
}

export function AddMappingForm({ model }: { model: AdminModel }) {
  const qc = useQueryClient();
  const cpaModels = useAdminQuery<{ data: { id: string }[] }>(
    ["admin", "cpa-models"],
    "/api/v1/admin/cpa/models",
  );
  const cpaIds = (cpaModels.data?.data ?? []).map((m) => m.id);
  const [provider, setProvider] = useState("");
  const [upstreamModel, setUpstreamModel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["admin", "mappings", model.id] });
    void qc.invalidateQueries({ queryKey: ["admin", "models"] });
  };

  const mutation = useMutation({
    mutationFn: () =>
      api(`/api/v1/admin/catalog/models/${model.id}/mappings`, {
        method: "POST",
        body: JSON.stringify({
          ...(provider.trim() ? { provider: provider.trim() } : {}),
          upstream_model: upstreamModel,
          enabled,
        }),
      }),
    onSuccess: () => {
      toast("Mapping added");
      setProvider("");
      setUpstreamModel("");
      invalidate();
    },
    onError: (e) => setError(e.message),
  });

  return (
    <>
      <form
        className="mt-2 grid gap-3 rounded-md border border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        <p className="text-sm font-medium">Add mapping to {model.public_id}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`provider-${model.id}`}>Provider</Label>
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
          </div>
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor={`enabled-${model.id}`}>Enabled</Label>
          <Switch id={`enabled-${model.id}`} checked={enabled} onCheckedChange={setEnabled} />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div>
          <Button type="submit" size="sm" disabled={mutation.isPending}>
            Add mapping
          </Button>
        </div>
      </form>

    </>
  );
}

function MappingsTable({ modelId }: { modelId: string }) {
  const mappings = useAdminQuery<MappingRow[]>(
    ["admin", "mappings", modelId],
    `/api/v1/admin/catalog/models/${modelId}/mappings`,
  );
  return (
    <AdminGate query={mappings}>
      <MappingsData rows={mappings.data ?? []} />
    </AdminGate>
  );
}

function MappingsData({ rows }: { rows: MappingRow[] }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (row: MappingRow) =>
      api(`/api/v1/admin/catalog/mappings/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: row.enabled !== 1 }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin", "mappings"] }),
    onError: (e) => toast(e.message),
  });
  return (
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
        {
          id: "enabled",
          header: "Enabled",
          cell: ({ row }) =>
            row.original.id ? (
              <Switch
                aria-label={`Enable mapping ${row.original.upstream_model}`}
                checked={row.original.enabled === 1}
                onCheckedChange={() => toggle.mutate(row.original)}
                disabled={toggle.isPending}
              />
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            ),
        },
      ]}
      data={rows}
      empty="No mappings yet."
    />
  );
}

export default function AdminProvidersPage() {
  const query = useAdminQuery<AdminModel[]>(["admin", "models"], "/api/v1/admin/catalog/models");
  const [selected, setSelected] = useState<string>("");

  return (
    <div className="space-y-4">
      <PageHeader title="Providers" description="Map public models to upstream provider models." />
      <AdminGate query={query}>
        <div className="grid gap-1.5">
          <Label htmlFor="model-select">Model</Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger id="model-select" className="max-w-sm">
              <SelectValue placeholder="Select a model…" />
            </SelectTrigger>
            <SelectContent>
              {(query.data ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.public_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {selected ? (
          (() => {
            const model = (query.data ?? []).find((m) => m.id === selected);
            return model ? (
              <>
                <AddMappingForm model={model} />
                <MappingsTable modelId={model.id} />
              </>
            ) : null;
          })()
        ) : (
          <EmptyState
            title="Select a model"
            description="Choose a model above to add a provider mapping."
          />
        )}
      </AdminGate>
    </div>
  );
}
