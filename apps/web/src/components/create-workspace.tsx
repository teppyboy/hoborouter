import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useWorkspaceStore } from "../lib/workspace";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/** Shown when the logged-in user has zero workspaces, so every workspace-scoped query is stuck pending. */
export function CreateWorkspace() {
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
        body: JSON.stringify({ name: name.trim() || "Personal" }),
      });
      setWorkspaceId(ws.id);
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-border p-6">
        <h1 className="text-lg font-semibold">Create your first workspace</h1>
        <div className="space-y-2">
          <Label htmlFor="workspace-name">Name</Label>
          <Input
            id="workspace-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Personal"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={create} disabled={pending || !name.trim()}>
          {pending ? "Creating…" : "Create"}
        </Button>
      </div>
    </div>
  );
}
