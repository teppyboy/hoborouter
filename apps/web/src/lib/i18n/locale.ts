import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Locale = "en" | "vi";

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useLocaleStore = create<LocaleState>()(
  persist(
    (set) => ({
      locale: "en",
      // Runtime guard: only en/vi ever enter state, so a corrupted or
      // hand-edited hbr-locale value cannot poison the store.
      setLocale: (locale) => {
        if (locale !== "en" && locale !== "vi") return;
        set({ locale });
      },
    }),
    { name: "hbr-locale" },
  ),
);

/** Mirror the active locale onto <html lang> for a11y. Safe under SSR: no document, no-op. */
export function applyLocale(locale: Locale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
}
