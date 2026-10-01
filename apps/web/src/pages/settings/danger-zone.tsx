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

export default function DangerZone({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState("");

  const remove = useMutation({
    mutationFn: () => api(`/api/v1/workspaces/${workspaceId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast("Workspace deleted");
      setWorkspaceId("");
      void qc.invalidateQueries({ queryKey: ["workspaces"] });
      qc.removeQueries({ queryKey: ["workspace", workspaceId] });
      setOpen(false);
      void navigate({ to: "/" });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Delete failed"),
  });

  return (
    <div className="max-w-md rounded-lg border border-destructive/40 p-4">
      <h3 className="text-sm font-medium">Danger zone</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Deleting a workspace removes it and all member access. Only the owner can delete.
      </p>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setTyped("");
        }}
      >
        <DialogTrigger asChild>
          <Button variant="destructive" size="sm" className="mt-3">
            Delete workspace
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete workspace</DialogTitle>
            <DialogDescription>
              This permanently deletes <span className="font-mono">{workspaceName}</span> and
              removes all members. Type the workspace name to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={workspaceName}
            aria-label="Type workspace name to confirm"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={typed !== workspaceName || remove.isPending}
              onClick={() => remove.mutateAsync().catch(() => undefined)}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
