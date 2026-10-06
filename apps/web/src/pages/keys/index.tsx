import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { KeyRound, MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { formatDate } from "../../lib/format";
import { formatStatusLabel } from "../../lib/display";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Label } from "../../components/ui/label";
import { DataTable, EmptyState, ErrorState, CopyButton, PageHeader } from "../../components/page";
import type { ColumnDef } from "@tanstack/react-table";

interface ApiKey {
  id: string;
  key_prefix: string;
  name: string;
  status: "enabled" | "disabled" | "revoked";
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface CatalogModelItem {
  id: string;
  public_id: string;
}

const nameSchema = z.object({
  // matches the API bound in apps/api/src/routes/keys.ts (MAX_KEY_NAME)
  name: z.string().trim().min(1, "Name is required").max(128, "At most 128 characters"),
});
type NameValues = z.infer<typeof nameSchema>;

const is403 = (e: unknown) => e instanceof ApiError && e.status === 403;

export default function KeysPage() {
  const workspaceId = useCurrentWorkspaceId();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  // Keep the last created key in state through the dialog's exit animation;
  // cleared on the next "Create key" open so it never lingers longer.
  const [created, setCreated] = useState<{ name: string; plaintext: string } | null>(null);
  const [showCreated, setShowCreated] = useState(false);
  const [restrictFor, setRestrictFor] = useState<ApiKey | null>(null);
  const [renameFor, setRenameFor] = useState<ApiKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ApiKey | null>(null);
  const [filter, setFilter] = useState("");

  const keysQuery = useQuery({
    queryKey: ["keys", workspaceId],
    queryFn: () => api<ApiKey[]>(`/api/v1/workspaces/${workspaceId}/keys`),
    enabled: !!workspaceId,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["keys", workspaceId] });

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      api<{ plaintext: string }>(`/api/v1/workspaces/${workspaceId}/keys`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: (_data, name) => {
      setCreateOpen(false);
      setCreated({ name, plaintext: _data.plaintext });
      setShowCreated(true);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Create failed"),
  });

  const statusMutation = useMutation({
    mutationFn: ({ keyId, status }: { keyId: string; status: "enabled" | "disabled" }) =>
      api(`/api/v1/workspaces/${workspaceId}/keys/${keyId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: (_d, v) => {
      toast(v.status === "enabled" ? "Key enabled" : "Key disabled");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Update failed"),
  });

  const renameMutation = useMutation({
    mutationFn: ({ keyId, name }: { keyId: string; name: string }) =>
      api(`/api/v1/workspaces/${workspaceId}/keys/${keyId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      toast("Key renamed");
      setRenameFor(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Rename failed"),
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) =>
      api(`/api/v1/workspaces/${workspaceId}/keys/${keyId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast("Key revoked");
      setRevokeTarget(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Revoke failed"),
  });

  const removeMutation = useMutation({
    mutationFn: (keyId: string) =>
      api(`/api/v1/workspaces/${workspaceId}/keys/${keyId}/remove`, { method: "POST" }),
    onSuccess: () => {
      toast("Key removed");
      setRemoveTarget(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Remove failed"),
  });

  const columns: ColumnDef<ApiKey, unknown>[] = [
    { accessorKey: "name", header: "Name" },
    {
      accessorKey: "key_prefix",
      header: "Key",
      enableSorting: false,
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.key_prefix}…</span>,
    },
    {
      accessorKey: "created_at",
      header: "Created",
      cell: ({ row }) => formatDate(new Date(row.original.created_at)),
    },
    {
      accessorKey: "last_used_at",
      header: "Last used",
      cell: ({ row }) =>
        row.original.last_used_at ? formatDate(new Date(row.original.last_used_at)) : "—",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => {
        const s = row.original.status;
        return (
          <Badge variant={s === "enabled" ? "default" : s === "disabled" ? "outline" : "secondary"}>
            {formatStatusLabel(s)}
          </Badge>
        );
      },
    },
    {
      id: "actions",
      enableSorting: false,
      header: "",
      cell: ({ row }) => {
        const key = row.original;
        if (key.status === "revoked") return null;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label="Key actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  statusMutation.mutate({
                    keyId: key.id,
                    status: key.status === "enabled" ? "disabled" : "enabled",
                  })
                }
              >
                {key.status === "enabled" ? "Disable" : "Enable"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRenameFor(key)}>Rename</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRestrictFor(key)}>
                Model restrictions
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => setRevokeTarget(key)}>
                Revoke
              </DropdownMenuItem>
              <DropdownMenuItem className="text-destructive" onClick={() => setRemoveTarget(key)}>
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  if (!workspaceId) return null;

  return (
    <div className="grid gap-4">
      <PageHeader
        title="API keys"
        description="Keys authenticate requests to the router. Admin/owner only."
        actions={
          <Button
            size="sm"
            onClick={() => {
              setCreated(null);
              setCreateOpen(true);
            }}
          >
            <Plus className="size-4" /> Create key
          </Button>
        }
      />
      {keysQuery.isPending ? (
        <div className="grid gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : keysQuery.isError ? (
        is403(keysQuery.error) ? (
          <EmptyState
            title="Not available"
            description="Only workspace admins and owners can manage API keys."
          />
        ) : (
          <ErrorState message={(keysQuery.error as Error).message} />
        )
      ) : (keysQuery.data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys"
          description="Create a key to start routing requests."
        />
      ) : (
        <DataTable
          columns={columns}
          data={keysQuery.data ?? []}
          globalFilter={filter}
          onGlobalFilterChange={setFilter}
        />
      )}

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        pending={createMutation.isPending}
        onSubmit={(name) => createMutation.mutate(name)}
      />

      {/* Plaintext shown exactly once; dialog stays populated during exit animation. */}
      <Dialog
        open={showCreated}
        onOpenChange={(open) => {
          if (!open) setShowCreated(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your API key</DialogTitle>
            <DialogDescription>
              This is the only time the full key for “{created?.name}” is shown. Store it somewhere
              safe — it cannot be retrieved again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs select-all">
              {created?.plaintext}
            </code>
            <CopyButton value={created?.plaintext ?? ""} label="Copy API key" />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowCreated(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {renameFor && (
        <RenameKeyDialog
          apiKey={renameFor}
          pending={renameMutation.isPending}
          onSubmit={(name) => renameMutation.mutate({ keyId: renameFor.id, name })}
          onOpenChange={(open) => {
            if (!open) setRenameFor(null);
          }}
        />
      )}

      {restrictFor && (
        <ModelRestrictionsDialog
          workspaceId={workspaceId}
          apiKey={restrictFor}
          onClose={() => setRestrictFor(null)}
          onSaved={() => {
            setRestrictFor(null);
            invalidate();
          }}
        />
      )}

      <Dialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke key</DialogTitle>
            <DialogDescription>
              Revoke “{revokeTarget?.name}”? Requests using this key will immediately fail. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRevokeTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={revokeMutation.isPending}
              onClick={() => revokeTarget && revokeMutation.mutate(revokeTarget.id)}
            >
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove = soft delete: hidden from the list, requests fail immediately.
          Distinct from revoke, which keeps the key visible as a revoked row. */}
      <Dialog
        open={!!removeTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove key</DialogTitle>
            <DialogDescription>
              Remove “{removeTarget?.name}” from this workspace? Requests using this key will
              immediately fail and it will disappear from the list. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={removeMutation.isPending}
              onClick={() => removeTarget && removeMutation.mutate(removeTarget.id)}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RenameKeyDialog({
  apiKey,
  pending,
  onSubmit,
  onOpenChange,
}: {
  apiKey: ApiKey;
  pending: boolean;
  onSubmit: (name: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const form = useForm<NameValues>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: apiKey.name },
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) form.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename key</DialogTitle>
          <DialogDescription>
            Current name: “{apiKey.name}”. Renaming does not change the key value.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => onSubmit(v.name))} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="rename-key-name">Name</Label>
            <Input id="rename-key-name" autoFocus {...form.register("name")} />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onSubmit: (name: string) => void;
}) {
  const form = useForm<NameValues>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: "" },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>Give the key a name so you can recognize it later.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => onSubmit(v.name))} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="key-name">Name</Label>
            <Input id="key-name" autoFocus {...form.register("name")} />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="submit" size="sm" disabled={pending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ModelRestrictionsDialog({
  workspaceId,
  apiKey,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  apiKey: ApiKey;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<string[] | null>(null);

  const currentQuery = useQuery({
    queryKey: ["keys", workspaceId, apiKey.id, "models"],
    queryFn: async () => {
      const res = await api<{ modelIds: string[] }>(
        `/api/v1/workspaces/${workspaceId}/keys/${apiKey.id}/models`,
      );
      setSelected(res.modelIds);
      return res.modelIds;
    },
  });

  const modelsQuery = useQuery({
    queryKey: ["catalog-models"],
    queryFn: () => api<{ data: CatalogModelItem[] }>("/api/v1/catalog/models"),
  });

  const saveMutation = useMutation({
    mutationFn: (modelIds: string[]) =>
      api(`/api/v1/workspaces/${workspaceId}/keys/${apiKey.id}/models`, {
        method: "PUT",
        body: JSON.stringify({ modelIds }),
      }),
    onSuccess: () => {
      toast("Model restrictions saved");
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const models = modelsQuery.data?.data ?? [];
  const toggle = (id: string) => {
    if (!selected) return;
    setSelected(selected.includes(id) ? selected.filter((m) => m !== id) : [...selected, id]);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Model restrictions — {apiKey.name}</DialogTitle>
          <DialogDescription>
            Leave empty to allow all models available to this workspace.
          </DialogDescription>
        </DialogHeader>
        {currentQuery.isPending || modelsQuery.isPending ? (
          <div className="grid gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : models.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not available yet.</p>
        ) : (
          <div className="grid gap-1">
            {models.map((m) => (
              <Label
                key={m.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm font-normal hover:bg-muted/50"
              >
                <input
                  type="checkbox"
                  checked={selected?.includes(m.id) ?? false}
                  onChange={() => toggle(m.id)}
                  className="size-4 accent-current"
                />
                <span className="font-mono text-xs">{m.public_id}</span>
              </Label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={saveMutation.isPending || !selected}
            onClick={() => saveMutation.mutate(selected ?? [])}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
