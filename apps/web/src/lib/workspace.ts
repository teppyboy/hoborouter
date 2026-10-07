import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safePersistStorage } from "./i18n/safe-storage";

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
    {
      name: "hbr-workspace",
      // Live-lookup storage (see i18n/safe-storage.ts): the default
      // createJSONStorage(() => localStorage) bakes in the storage object at
      // module load and breaks when the module loads before jsdom/tests install
      // one; in the browser behavior is identical.
      storage: safePersistStorage<WorkspaceState>(),
    },
  ),
);
