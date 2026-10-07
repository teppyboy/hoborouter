import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useWorkspaceStore } from "../lib/workspace";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { useT } from "../lib/i18n/t";

// First-workspace copy: inline LocaleEntry set (see lib/i18n/common.ts).
const workspaceCopy = {
  title: { en: "Create your first workspace", vi: "Tạo workspace đầu tiên của bạn" },
  name: { en: "Name", vi: "Tên" },
  personal: { en: "Personal", vi: "Cá nhân" },
  creating: { en: "Creating…", vi: "Đang tạo…" },
  create: { en: "Create", vi: "Tạo" },
  createFailed: { en: "Failed to create workspace", vi: "Không tạo được workspace" },
} as const;

/** Shown when the logged-in user has zero workspaces, so every workspace-scoped query is stuck pending. */
export function CreateWorkspace() {
  const t = useT(workspaceCopy);
  const [name, setName] = useState("Personal");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);
  const queryClient = useQueryClient();

  async function create() {
    setPending(true);
    setError(null);
    try {
      const ws = await api<{ id: string }>("/api/v1/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() || t("personal") }),
      });
      setWorkspaceId(ws.id);
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("createFailed"));
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-border p-6">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <div className="space-y-2">
          <Label htmlFor="workspace-name">{t("name")}</Label>
          <Input
            id="workspace-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("personal")}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={create} disabled={pending || !name.trim()}>
          {pending ? t("creating") : t("create")}
        </Button>
      </div>
    </div>
  );
}
