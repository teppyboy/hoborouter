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
import { AdminGate, type AdminModel, useAdminQuery } from "./shared";

function AddMappingForm({ model }: { model: AdminModel }) {
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

  const mutation = useMutation({
    mutationFn: () =>
      api(`/api/v1/admin/catalog/models/${model.id}/mappings`, {
        method: "POST",
        body: JSON.stringify({ provider, upstream_model: upstreamModel, enabled }),
      }),
    onSuccess: () => {
      toast("Mapping added");
      setProvider("");
      setUpstreamModel("");
      void qc.invalidateQueries({ queryKey: ["admin", "models"] });
    },
    onError: (e) => setError(e.message),
  });

  return (
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
            required
          />
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
            return model ? <AddMappingForm model={model} /> : null;
          })()
        ) : (
          <EmptyState
            title="Select a model"
            description="Choose a model above to add a provider mapping."
          />
        )}
        <section>
          <h2 className="mb-2 text-sm font-medium">Existing mappings</h2>
          <DataTable
            columns={[{ header: "Provider", accessorKey: "provider" }]}
            data={[]}
            empty="Listing existing mappings is not available yet — the API has no GET endpoint for mappings."
          />
        </section>
      </AdminGate>
    </div>
  );
}
