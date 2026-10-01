import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useWorkspaceStore } from "../lib/workspace";

export interface Workspace {
  id: string;
  name: string;
}

/** List workspaces and auto-select the first one. */
export function useWorkspaces() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);

  const query = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api<Workspace[]>("/api/v1/workspaces"),
  });

  useEffect(() => {
    const list = query.data;
    if (!query.isSuccess || !list || list.length === 0) return;
    if (!list.some((w) => w.id === workspaceId)) {
      setWorkspaceId(list[0]?.id ?? "");
    }
  }, [query.isSuccess, query.data, workspaceId, setWorkspaceId]);

  return query;
}

/**
 * Workspace id validated against the fetched list: only an id the current user
 * actually belongs to, null until the list loads. Prevents a persisted id from
 * another account hitting workspace-scoped APIs before validation (401/403).
 */
export function useCurrentWorkspaceId(): string | null {
  const stored = useWorkspaceStore((s) => s.workspaceId);
  const { data, isSuccess } = useWorkspaces();
  if (!isSuccess || !data?.length) return null;
  return data.some((w) => w.id === stored) ? stored : (data[0]?.id ?? null);
}
