// PersistStorage that follows the LIVE global localStorage at call time and
// no-ops when none exists. zustand's default createJSONStorage(() => localStorage)
// returns an unusable store wrapper when the module first loads in an
// environment without localStorage (e.g. test files that import the store
// before installing jsdom), silently dropping the whole persist API. This
// adapter keeps `.persist` usable in every module-load order; in the browser
// it reads and writes the real localStorage exactly like the default.
export function safePersistStorage<S>() {
  const ls = () => (globalThis as { localStorage?: Storage }).localStorage;
  return {
    getItem: (name: string): { state: S; version: number } | null => {
      const raw = ls()?.getItem(name);
      return raw ? (JSON.parse(raw) as { state: S; version: number }) : null;
    },
    setItem: (name: string, value: { state: S; version?: number }) => {
      ls()?.setItem(name, JSON.stringify(value));
    },
    removeItem: (name: string) => {
      ls()?.removeItem(name);
    },
  };
}
