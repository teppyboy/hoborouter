import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safePersistStorage } from "./i18n/safe-storage";

interface SidebarState {
  collapsed: boolean;
  toggleCollapsed: () => void;
}
// Exported for tests that stub the persisted hbr-sidebar storage payload.
export type { SidebarState };

/** Sidebar collapsed state, persisted to localStorage (icon-only rail when collapsed). */
export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      collapsed: false,
      toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
    }),
    { name: "hbr-sidebar", storage: safePersistStorage<SidebarState>() },
  ),
);
