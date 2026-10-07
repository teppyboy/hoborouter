import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { api, ApiError } from "../../lib/api";
import { useWorkspaceStore } from "../../lib/workspace";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { useT } from "../../lib/i18n/t";

// Danger-zone copy: inline LocaleEntry set (see lib/i18n/common.ts).
const dangerCopy = {
  deleted: { en: "Workspace deleted", vi: "Đã xoá workspace" },
  deleteFailed: { en: "Delete failed", vi: "Xoá thất bại" },
  title: { en: "Danger zone", vi: "Vùng nguy hiểm" },
  description: {
    en: "Deleting a workspace removes it and all member access. Only the owner can delete.",
    vi: "Xoá workspace sẽ xoá nó cùng toàn bộ quyền truy cập của thành viên. Chỉ chủ sở hữu mới có thể xoá.",
  },
  deleteWorkspace: { en: "Delete workspace", vi: "Xoá workspace" },
  deleteConfirm: {
    en: "This permanently deletes {name} and removes all members. Type the workspace name to confirm.",
    vi: "Thao tác này xoá vĩnh viễn {name} và xoá mọi thành viên. Nhập tên workspace để xác nhận.",
  },
  typeToConfirm: {
    en: "Type workspace name to confirm",
    vi: "Nhập tên workspace để xác nhận",
  },
  cancel: { en: "Cancel", vi: "Huỷ" },
  deleting: { en: "Deleting…", vi: "Đang xoá…" },
  delete: { en: "Delete", vi: "Xoá" },
} as const;

export default function DangerZone({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const t = useT(dangerCopy);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState("");

  const remove = useMutation({
    mutationFn: () => api(`/api/v1/workspaces/${workspaceId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast(t("deleted"));
      setWorkspaceId("");
      void qc.invalidateQueries({ queryKey: ["workspaces"] });
      qc.removeQueries({ queryKey: ["workspace", workspaceId] });
      setOpen(false);
      void navigate({ to: "/" });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("deleteFailed")),
  });

  return (
    <div className="max-w-md rounded-lg border border-destructive/40 p-4">
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setTyped("");
        }}
      >
        <DialogTrigger asChild>
          <Button variant="destructive" size="sm" className="mt-3">
            {t("deleteWorkspace")}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteWorkspace")}</DialogTitle>
            <DialogDescription>{t("deleteConfirm", { name: workspaceName })}</DialogDescription>
          </DialogHeader>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={workspaceName}
            aria-label={t("typeToConfirm")}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={typed !== workspaceName || remove.isPending}
              onClick={() => remove.mutateAsync().catch(() => undefined)}
            >
              {remove.isPending ? t("deleting") : t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
