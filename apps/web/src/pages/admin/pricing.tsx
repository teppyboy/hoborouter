import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, EmptyState, PageHeader } from "../../components/page";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { api } from "../../lib/api";
import { formatUsdMicroPer1m } from "../../lib/format";
import { AdminGate, type AdminModel, usdPer1mToMicro, useAdminQuery } from "./shared";

const PRICE_INPUTS = [
  { key: "input_usd_micro_per_1m", label: "Input USD / 1M tokens" },
  { key: "output_usd_micro_per_1m", label: "Output USD / 1M tokens" },
  { key: "cached_input_usd_micro_per_1m", label: "Cached input USD / 1M tokens" },
  { key: "reasoning_usd_micro_per_1m", label: "Reasoning USD / 1M tokens" },
] as const;

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

function AddPriceDialog({
  model,
  open,
  onOpenChange,
}: {
  model: AdminModel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [usd, setUsd] = useState<Record<string, string>>({});
  const qc = useQueryClient();
  // Markup entered as a multiple (1 = sell at cost). 1,000,000 ppm = 1×.
  // 0 markup would make every gateway request fail (positive charge cap).
  const [markupX, setMarkupX] = useState("1");
  const [error, setError] = useState<string | null>(null);

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
      return api(`/api/v1/admin/catalog/models/${model.id}/prices`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      toast("Price row added");
      void qc.invalidateQueries({ queryKey: ["admin", "prices", model.id] });
      void qc.invalidateQueries({ queryKey: ["admin", "models"] });
      onOpenChange(false);
    },
    onError: (e) => setError(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add price row — {model.public_id}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            mutation.mutate();
          }}
        >
          {PRICE_INPUTS.map((f) => (
            <div key={f.key} className="grid gap-1.5">
              <Label htmlFor={f.key}>{f.label}</Label>
              <Input
                id={f.key}
                className="font-mono"
                inputMode="decimal"
                placeholder="0.001500"
                value={usd[f.key] ?? ""}
                onChange={(e) => setUsd((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            </div>
          ))}
          <div className="grid gap-1.5">
            <Label htmlFor="markup_ppm">Markup (×)</Label>
            <Input
              id="markup_ppm"
              className="font-mono"
              inputMode="decimal"
              value={markupX}
              onChange={(e) => setMarkupX(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              Add price
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminPricingPage() {
  const query = useAdminQuery<AdminModel[]>(["admin", "models"], "/api/v1/admin/catalog/models");
  const [selected, setSelected] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const model = (query.data ?? []).find((m) => m.id === selected);
  const prices = useAdminQuery<PriceRow[]>(
    ["admin", "prices", selected],
    selected ? `/api/v1/admin/catalog/models/${selected}/prices` : "",
  );

  const columns: ColumnDef<PriceRow, unknown>[] = [
    {
      header: "Effective at",
      accessorKey: "effective_at",
      cell: (c) => new Date(c.getValue() as number).toLocaleString(),
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

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pricing"
        description="USD prices per 1M tokens. Price rows are immutable — changes append a new row."
      />
      <AdminGate query={query}>
        <div className="flex items-end gap-3">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="pricing-model">Model</Label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger id="pricing-model" className="max-w-sm">
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
          <Button size="sm" disabled={!model} onClick={() => setDialogOpen(true)}>
            <Plus className="size-4" /> Add price
          </Button>
        </div>
        <section>
          <h2 className="mb-2 text-sm font-medium">Current &amp; historical prices</h2>
          {model ? (
            <AdminGate query={prices}>
              <DataTable columns={columns} data={prices.data ?? []} empty="No price rows yet." />
            </AdminGate>
          ) : null}
        </section>
        {!model && (
          <EmptyState
            title="Select a model"
            description="Choose a model above to add a price row."
          />
        )}
      </AdminGate>
      {model && <AddPriceDialog model={model} open={dialogOpen} onOpenChange={setDialogOpen} />}
    </div>
  );
}
