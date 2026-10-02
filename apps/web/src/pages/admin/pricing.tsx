import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { DataTable, EmptyState, PageHeader } from "../../components/page";
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
import { AdminGate, type AdminModel, usdPer1mToMicro, useAdminQuery } from "./shared";

const PRICE_INPUTS = [
  { key: "input_usd_micro_per_1m", label: "Input USD / 1M tokens" },
  { key: "output_usd_micro_per_1m", label: "Output USD / 1M tokens" },
  { key: "cached_input_usd_micro_per_1m", label: "Cached input USD / 1M tokens" },
  { key: "reasoning_usd_micro_per_1m", label: "Reasoning USD / 1M tokens" },
] as const;

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
  // 1,000,000 ppm = 1x. Billing requires a positive charge cap, so 0 markup
  // would make every gateway request fail; default to sell-at-cost plus none.
  const [markupPpm, setMarkupPpm] = useState("1000000");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const body: Record<string, number> = {};
      for (const f of PRICE_INPUTS) {
        const micro = usdPer1mToMicro(usd[f.key] ?? "");
        if (micro === null) throw new Error(`${f.label}: enter a USD amount with up to 6 decimals`);
        body[f.key] = micro;
      }
      const ppm = Number(markupPpm);
      if (!Number.isSafeInteger(ppm) || ppm < 0)
        throw new Error("Markup must be a non-negative integer (ppm)");
      body.markup_ppm = ppm;
      return api(`/api/v1/admin/catalog/models/${model.id}/prices`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      toast("Price row added");
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
            <Label htmlFor="markup_ppm">Markup (ppm, integer)</Label>
            <Input
              id="markup_ppm"
              className="font-mono"
              type="number"
              min={0}
              value={markupPpm}
              onChange={(e) => setMarkupPpm(e.target.value)}
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
          <DataTable
            columns={[
              { header: "Effective at", accessorKey: "effective_at" },
              { header: "Input", accessorKey: "input_usd_micro_per_1m" },
              { header: "Output", accessorKey: "output_usd_micro_per_1m" },
            ]}
            data={[]}
            empty="Price history is not available yet — the API has no GET endpoint for model prices."
          />
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
