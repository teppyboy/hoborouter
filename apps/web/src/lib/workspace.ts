import { create } from "zustand";
import { persist } from "zustand/middleware";

interface WorkspaceState {
  workspaceId: string | null;
  setWorkspaceId: (id: string) => void;
}

/** Current workspace selection, persisted to localStorage. */
export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      workspaceId: null,
      setWorkspaceId: (workspaceId) => set({ workspaceId }),
    }),
    { name: "hbr-workspace" },
  ),
);
