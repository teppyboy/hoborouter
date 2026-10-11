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
import { useT } from "../../lib/i18n/t";

// API keys page copy: inline LocaleEntry set (see lib/i18n/common.ts). Key
// prefixes, plaintext values and model IDs are never translated.
const keysCopy = {
  nameRequired: { en: "Name is required", vi: "Vui lòng nhập tên" },
  nameTooLong: { en: "At most 128 characters", vi: "Tối đa 128 ký tự" },
  createFailed: { en: "Create failed", vi: "Tạo thất bại" },
  keyEnabled: { en: "Key enabled", vi: "Đã bật key" },
  keyDisabled: { en: "Key disabled", vi: "Đã tắt key" },
  updateFailed: { en: "Update failed", vi: "Cập nhật thất bại" },
  keyRenamed: { en: "Key renamed", vi: "Đã đổi tên key" },
  renameFailed: { en: "Rename failed", vi: "Đổi tên thất bại" },
  keyRevoked: { en: "Key revoked", vi: "Đã thu hồi key" },
  revokeFailed: { en: "Revoke failed", vi: "Thu hồi thất bại" },
  nameCol: { en: "Name", vi: "Tên" },
  keyCol: { en: "Key", vi: "Key" },
  createdCol: { en: "Created", vi: "Ngày tạo" },
  lastUsedCol: { en: "Last used", vi: "Dùng lần cuối" },
  statusCol: { en: "Status", vi: "Trạng thái" },
  keyActions: { en: "Key actions", vi: "Thao tác với key" },
  disable: { en: "Disable", vi: "Tắt" },
  enable: { en: "Enable", vi: "Bật" },
  rename: { en: "Rename", vi: "Đổi tên" },
  modelRestrictions: { en: "Model restrictions", vi: "Giới hạn mô hình" },
  revoke: { en: "Revoke", vi: "Thu hồi" },
  remove: { en: "Remove", vi: "Xoá" },
  removeKey: { en: "Remove key", vi: "Xoá key" },
  removeConfirm: {
    en: "Remove “{name}” from this workspace? It will disappear from the list and stop authenticating requests.",
    vi: "Xoá “{name}” khỏi workspace? Key sẽ biến mất khỏi danh sách và không còn xác thực request.",
  },
  keyRemoved: { en: "Key removed", vi: "Đã xoá key" },
  removeFailed: { en: "Remove failed", vi: "Xoá thất bại" },
  title: { en: "API keys", vi: "API key" },
  keysTable: { en: "Keys list", vi: "Danh sách key" },
  description: {
    en: "Keys authenticate requests to the router. Admin/owner only.",
    vi: "Key dùng để xác thực request tới router. Chỉ dành cho quản trị/chủ sở hữu.",
  },
  createKey: { en: "Create key", vi: "Tạo key" },
  notAvailable: { en: "Not available", vi: "Không khả dụng" },
  notAvailableDesc: {
    en: "Only workspace admins and owners can manage API keys.",
    vi: "Chỉ quản trị viên và chủ sở hữu workspace mới có thể quản lý API key.",
  },
  noKeys: { en: "No API keys", vi: "Chưa có API key nào" },
  noKeysDesc: {
    en: "Create a key to start routing requests.",
    vi: "Tạo một key để bắt đầu định tuyến request.",
  },
  copyYourKey: { en: "Copy your API key", vi: "Copy API key của bạn" },
  onlyShownOnce: {
    en: "This is the only time the full key for “{name}” is shown. Store it somewhere safe — it cannot be retrieved again.",
    vi: "Đây là lần duy nhất full key của “{name}” được hiển thị. Hãy lưu ở nơi an toàn — không thể lấy lại.",
  },
  copyApiKey: { en: "Copy API key", vi: "Copy API key" },
  done: { en: "Done", vi: "Xong" },
  revokeKey: { en: "Revoke key", vi: "Thu hồi key" },
  revokeConfirm: {
    en: "Revoke “{name}”? Requests using this key will immediately fail. This cannot be undone.",
    vi: "Thu hồi “{name}”? Request dùng key này sẽ thất bại ngay lập tức. Không thể hoàn tác.",
  },
  cancel: { en: "Cancel", vi: "Huỷ" },
  renameKey: { en: "Rename key", vi: "Đổi tên key" },
  renameCurrentName: {
    en: "Current name: “{name}”. Renaming does not change the key value.",
    vi: "Tên hiện tại: “{name}”. Đổi tên không thay đổi giá trị key.",
  },
  save: { en: "Save", vi: "Lưu" },
  create: { en: "Create", vi: "Tạo" },
  createKeyTitle: { en: "Create API key", vi: "Tạo API key" },
  createKeyDesc: {
    en: "Give the key a name so you can recognize it later.",
    vi: "Đặt tên cho key để nhận ra nó về sau.",
  },
  restrictionsSaved: { en: "Model restrictions saved", vi: "Đã lưu giới hạn mô hình" },
  saveFailed: { en: "Save failed", vi: "Lưu thất bại" },
  restrictionsTitle: { en: "Model restrictions — {name}", vi: "Giới hạn mô hình — {name}" },
  restrictionsDesc: {
    en: "Leave empty to allow all models available to this workspace.",
    vi: "Để trống để cho phép tất cả mô hình khả dụng với workspace này.",
  },
  notAvailableYet: { en: "Not available yet.", vi: "Chưa khả dụng." },
} as const;

const makeNameSchema = (t: (k: "nameRequired" | "nameTooLong") => string) =>
  z.object({
    // matches the API bound in apps/api/src/routes/keys.ts (MAX_KEY_NAME)
    name: z.string().trim().min(1, t("nameRequired")).max(128, t("nameTooLong")),
  });
type NameValues = { name: string };

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

const is403 = (e: unknown) => e instanceof ApiError && e.status === 403;

export default function KeysPage() {
  const t = useT(keysCopy);
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
    onError: (e) => toast.error(e instanceof Error ? e.message : t("createFailed")),
  });

  const statusMutation = useMutation({
    mutationFn: ({ keyId, status }: { keyId: string; status: "enabled" | "disabled" }) =>
      api(`/api/v1/workspaces/${workspaceId}/keys/${keyId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: (_d, v) => {
      toast(v.status === "enabled" ? t("keyEnabled") : t("keyDisabled"));
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t("updateFailed")),
  });

  const renameMutation = useMutation({
    mutationFn: ({ keyId, name }: { keyId: string; name: string }) =>
      api(`/api/v1/workspaces/${workspaceId}/keys/${keyId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      toast(t("keyRenamed"));
      setRenameFor(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t("renameFailed")),
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) =>
      api(`/api/v1/workspaces/${workspaceId}/keys/${keyId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast(t("keyRevoked"));
      setRevokeTarget(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t("revokeFailed")),
  });

  const removeMutation = useMutation({
    mutationFn: (keyId: string) =>
      api(`/api/v1/workspaces/${workspaceId}/keys/${keyId}/remove`, { method: "POST" }),
    onSuccess: () => {
      toast(t("keyRemoved"));
      setRemoveTarget(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t("removeFailed")),
  });

  const columns: ColumnDef<ApiKey, unknown>[] = [
    { accessorKey: "name", header: t("nameCol") },
    {
      accessorKey: "key_prefix",
      header: t("keyCol"),
      enableSorting: false,
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.key_prefix}…</span>,
    },
    {
      accessorKey: "created_at",
      header: t("createdCol"),
      cell: ({ row }) => formatDate(new Date(row.original.created_at)),
    },
    {
      accessorKey: "last_used_at",
      header: t("lastUsedCol"),
      cell: ({ row }) =>
        row.original.last_used_at ? formatDate(new Date(row.original.last_used_at)) : "—",
    },
    {
      accessorKey: "status",
      header: t("statusCol"),
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
        if (key.status === "revoked") {
          // Revoked is terminal (PATCH status and rename are 409 on the API);
          // only cleanup via the existing POST /remove soft-delete remains.
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label={t("keyActions")}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => setRemoveTarget(key)}
                >
                  {t("remove")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        }
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t("keyActions")}>
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
                {key.status === "enabled" ? t("disable") : t("enable")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRenameFor(key)}>{t("rename")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRestrictFor(key)}>
                {t("modelRestrictions")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => setRevokeTarget(key)}>
                {t("revoke")}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-destructive" onClick={() => setRemoveTarget(key)}>
                {t("remove")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  if (!workspaceId) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button
            size="sm"
            onClick={() => {
              setCreated(null);
              setCreateOpen(true);
            }}
          >
            <Plus className="size-4" /> {t("createKey")}
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
          <EmptyState title={t("notAvailable")} description={t("notAvailableDesc")} />
        ) : (
          <ErrorState message={(keysQuery.error as Error).message} />
        )
      ) : (keysQuery.data?.length ?? 0) === 0 ? (
        <EmptyState icon={KeyRound} title={t("noKeys")} description={t("noKeysDesc")} />
      ) : (
        <DataTable
          columns={columns}
          data={keysQuery.data ?? []}
          globalFilter={filter}
          onGlobalFilterChange={setFilter}
          scroll={{ label: t("keysTable"), fill: true }}
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
            <DialogTitle>{t("copyYourKey")}</DialogTitle>
            <DialogDescription>
              {t("onlyShownOnce", { name: created?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs select-all">
              {created?.plaintext}
            </code>
            <CopyButton value={created?.plaintext ?? ""} label={t("copyApiKey")} />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowCreated(false)}>
              {t("done")}
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
        open={!!removeTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("removeKey")}</DialogTitle>
            <DialogDescription>
              {t("removeConfirm", { name: removeTarget?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRemoveTarget(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={removeMutation.isPending}
              onClick={() => removeTarget && removeMutation.mutate(removeTarget.id)}
            >
              {t("remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("revokeKey")}</DialogTitle>
            <DialogDescription>
              {t("revokeConfirm", { name: revokeTarget?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRevokeTarget(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={revokeMutation.isPending}
              onClick={() => revokeTarget && revokeMutation.mutate(revokeTarget.id)}
            >
              {t("revoke")}
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
  const t = useT(keysCopy);
  const form = useForm<NameValues>({
    resolver: zodResolver(makeNameSchema(t)),
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
          <DialogTitle>{t("renameKey")}</DialogTitle>
          <DialogDescription>{t("renameCurrentName", { name: apiKey.name })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => onSubmit(v.name))} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="rename-key-name">{t("nameCol")}</Label>
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
              {t("rename")}
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
  const t = useT(keysCopy);
  const form = useForm<NameValues>({
    resolver: zodResolver(makeNameSchema(t)),
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
          <DialogTitle>{t("createKeyTitle")}</DialogTitle>
          <DialogDescription>{t("createKeyDesc")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => onSubmit(v.name))} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="key-name">{t("nameCol")}</Label>
            <Input id="key-name" autoFocus {...form.register("name")} />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="submit" size="sm" disabled={pending}>
              {t("create")}
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
  const t = useT(keysCopy);
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
      toast(t("restrictionsSaved"));
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t("saveFailed")),
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
          <DialogTitle>{t("restrictionsTitle", { name: apiKey.name })}</DialogTitle>
          <DialogDescription>{t("restrictionsDesc")}</DialogDescription>
        </DialogHeader>
        {currentQuery.isPending || modelsQuery.isPending ? (
          <div className="grid gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : models.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("notAvailableYet")}</p>
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
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            disabled={saveMutation.isPending || !selected}
            onClick={() => saveMutation.mutate(selected ?? [])}
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
