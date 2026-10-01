import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  DataTable,
  EmptyState,
  CopyButton,
  PageHeader,
} from "../../components/page";
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
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { api } from "../../lib/api";
import { formatTokens } from "../../lib/format";
import { AdminGate, type AdminModel, parseCapabilities, useAdminQuery } from "./shared";

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

function ModelDialog({
  model,
  open,
  onOpenChange,
}: {
  model: AdminModel | null; // null = create
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: model
      ? {
          public_id: model.public_id,
          display_name: model.display_name,
          provider: model.provider,
          description: model.description ?? "",
          capabilities: model.capabilities ? JSON.parse(model.capabilities).join(", ") : "",
          context_window: model.context_window == null ? "" : String(model.context_window),
          enabled: model.enabled === 1,
          published: model.published === 1,
        }
      : { public_id: "", display_name: "", provider: "", description: "", capabilities: "", context_window: "", enabled: true, published: false },
  });

  const mutation = useMutation({
    mutationFn: (v: Values) => {
      const ctx_window = v.context_window?.trim() ? Number(v.context_window) : null;
      if (ctx_window !== null && (!Number.isSafeInteger(ctx_window) || ctx_window <= 0))
        throw new Error("Context window must be a positive integer");
      const body = {
        public_id: v.public_id,
        slug: v.public_id.split("/")[1],
        display_name: v.display_name,
        provider: v.provider,
        description: v.description || null,
        capabilities: parseCapabilities(v.capabilities ?? ""),
        context_window: ctx_window,
        enabled: v.enabled,
        published: v.published,
      };
      return model
        ? api(`/api/v1/admin/catalog/models/${model.id}`, { method: "PUT", body: JSON.stringify(body) })
        : api("/api/v1/admin/catalog/models", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      toast(model ? "Model updated" : "Model created");
      qc.invalidateQueries({ queryKey: ["admin", "models"] });
      onOpenChange(false);
    },
    onError: (e) => form.setError("root", { message: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{model ? `Edit ${model.public_id}` : "Create model"}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
          className="grid gap-3"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="public_id">Public ID</Label>
            <Input id="public_id" className="font-mono" disabled={!!model} {...form.register("public_id")} />
            {form.formState.errors.public_id && (
              <p className="text-xs text-destructive">{form.formState.errors.public_id.message}</p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="display_name">Display name</Label>
            <Input id="display_name" {...form.register("display_name")} />
            {form.formState.errors.display_name && (
              <p className="text-xs text-destructive">{form.formState.errors.display_name.message}</p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="provider">Provider</Label>
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
            <Input id="capabilities" placeholder="chat, tools, vision" {...form.register("capabilities")} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="context_window">Context window</Label>
            <Input id="context_window" type="number" min={1} {...form.register("context_window")} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="enabled">Enabled</Label>
            <Switch id="enabled" checked={form.watch("enabled")} onCheckedChange={(c) => form.setValue("enabled", c)} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="published">Published</Label>
            <Switch id="published" checked={form.watch("published")} onCheckedChange={(c) => form.setValue("published", c)} />
          </div>
          {form.formState.errors.root && (
            <p className="text-xs text-destructive">{form.formState.errors.root.message}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              {model ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminModelsPage() {
  const query = useAdminQuery<AdminModel[]>(["admin", "models"], "/api/v1/admin/catalog/models");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminModel | null>(null);

  const columns: ColumnDef<AdminModel, unknown>[] = [
    {
      accessorKey: "public_id",
      header: "Public ID",
      cell: ({ row }) => (
        <span className="flex items-center gap-1 font-mono text-xs">
          {row.original.public_id}
          <CopyButton value={row.original.public_id} label="Copy public ID" />
        </span>
      ),
    },
    { accessorKey: "display_name", header: "Name" },
    { accessorKey: "provider", header: "Provider", cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span> },
    {
      accessorKey: "context_window",
      header: "Context",
      cell: (c) => <span className="font-mono text-xs">{c.getValue() == null ? "—" : formatTokens(c.getValue() as number)}</span>,
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <span className="flex gap-1">
          {row.original.enabled === 1 ? <Badge variant="outline">enabled</Badge> : <Badge variant="secondary">disabled</Badge>}
          {row.original.published === 1 && <Badge variant="outline">published</Badge>}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setEditing(row.original);
            setDialogOpen(true);
          }}
        >
          Edit
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
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
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
      <ModelDialog model={editing} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
