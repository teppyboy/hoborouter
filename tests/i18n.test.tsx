// Locale core contract: typed area dictionaries (translate/useT), the persisted
// hbr-locale store, and <html lang> mirroring. Real jsdom (the tests
// devDependency) is installed as the global before the store module is
// imported so zustand persist finds a real localStorage; originals are
// restored in afterAll so other test files in this process are unaffected.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { LocaleState } from "../apps/web/src/lib/i18n/locale";

const GLOBAL_KEYS = ["window", "document", "localStorage", "location"] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

/** PersistStorage following the LIVE global localStorage at call time; no-ops
 *  when no test environment has installed one. Never undefined, so lazily
 *  binding stores (sidebar) cannot crash on persist writes. */
function liveLocalStorageAdapter<S>() {
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

let translate: (typeof import("../apps/web/src/lib/i18n/t"))["translate"];
let applyLocale: (typeof import("../apps/web/src/lib/i18n/locale"))["applyLocale"];
let useLocaleStore: (typeof import("../apps/web/src/lib/i18n/locale"))["useLocaleStore"];
let LanguageToggle: (typeof import("../apps/web/src/components/language-toggle"))["LanguageToggle"];

beforeAll(async () => {
  // Real URL: modules reading location.origin see the actual dev origin.
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as {
    document: object;
    localStorage: Storage;
    location: unknown;
    close: () => void;
  };
  for (const k of GLOBAL_KEYS) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  jsdomWindow = win;
  // Import AFTER the jsdom globals exist: zustand persist binds its storage
  // (localStorage) when the store module first loads. Sibling files (e.g.
  // sidebar-hover-ui) may have loaded the store first in this process without
  // a localStorage, leaving persist bound to a missing storage — rebind to a
  // storage that reads the CURRENT global localStorage at call time, so every
  // file that installs its own jsdom gets correct persistence without
  // touching store runtime code.
  ({ translate } = await import("../apps/web/src/lib/i18n/t"));
  ({ applyLocale, useLocaleStore } = await import("../apps/web/src/lib/i18n/locale"));
  // Root-cause storage isolation: bind a never-undefined adapter that follows
  // the LIVE global localStorage at call time and no-ops when no environment
  // has installed one. Restoring `storage: undefined` in afterAll instead
  // crashed sibling stores that lazily bind (sidebar persist at
  // middleware.mjs setItem), so this adapter stays bound for the process.
  useLocaleStore.persist.setOptions({ storage: liveLocalStorageAdapter() });
  ({ LanguageToggle } = await import("../apps/web/src/components/language-toggle"));
});

afterAll(() => {
  useLocaleStore.getState().setLocale("en");
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

const dict = {
  greeting: {
    en: "Hello {name}, you have {count} keys",
    vi: "Xin chào {name}, bạn có {count} khoá",
  },
  plain: { en: "Save", vi: "Lưu" },
} as const;

// --- pure translate -------------------------------------------------------

test("translate returns the English and Vietnamese strings", () => {
  expect(translate(dict, "plain", "en")).toBe("Save");
  expect(translate(dict, "plain", "vi")).toBe("Lưu");
});

test("translate replaces {placeholders} with string and number vars literally", () => {
  expect(translate(dict, "greeting", "en", { name: "Minh", count: 3 })).toBe(
    "Hello Minh, you have 3 keys",
  );
  expect(translate(dict, "greeting", "vi", { name: "Minh", count: 0 })).toBe(
    "Xin chào Minh, bạn có 0 khoá",
  );
});

test("translate never interprets var values as HTML or regex", () => {
  const htmlDict = { msg: { en: "Value: {v}", vi: "Giá trị: {v}" } } as const;
  expect(translate(htmlDict, "msg", "en", { v: "<img src=x onerror=alert(1)> $& (a)" })).toBe(
    "Value: <img src=x onerror=alert(1)> $& (a)",
  );
});

test("translate leaves unknown {tokens} untouched and falls back to en", () => {
  expect(translate(dict, "plain", "en", { missing: 1 })).toBe("Save");
  const partial = { only: { en: "Only EN", vi: undefined as unknown as string } } as const;
  expect(translate(partial, "only", "vi")).toBe("Only EN");
});

// --- locale store -----------------------------------------------------------

test("locale store defaults to en and persists changes to hbr-locale", () => {
  expect(useLocaleStore.getState().locale).toBe("en");
  useLocaleStore.getState().setLocale("vi");
  expect(useLocaleStore.getState().locale).toBe("vi");
  const raw = window.localStorage.getItem("hbr-locale");
  expect(raw).toContain('"locale":"vi"');
  useLocaleStore.getState().setLocale("en");
});

test("persist rehydrates the stored locale into a reset store", async () => {
  useLocaleStore.getState().setLocale("vi");
  useLocaleStore.setState({ locale: "en" }); // simulate a fresh session state
  window.localStorage.setItem(
    "hbr-locale",
    JSON.stringify({ state: { locale: "vi" }, version: 0 }),
  );
  await useLocaleStore.persist.rehydrate();
  expect(useLocaleStore.getState().locale).toBe("vi");
  useLocaleStore.getState().setLocale("en");
});

test("invalid locales are rejected and a corrupt persisted value cannot crash translation", async () => {
  useLocaleStore.getState().setLocale("fr" as "en");
  expect(useLocaleStore.getState().locale).toBe("en");
  window.localStorage.setItem(
    "hbr-locale",
    JSON.stringify({ state: { locale: "xx" }, version: 0 }),
  );
  await useLocaleStore.persist.rehydrate();
  // Unknown locale degrades to the English string instead of crashing.
  expect(translate(dict, "plain", useLocaleStore.getState().locale as "en")).toBe("Save");
  useLocaleStore.getState().setLocale("en");
});

// --- html.lang --------------------------------------------------------------

test("applyLocale mirrors the locale onto <html lang>", () => {
  applyLocale("vi");
  expect(document.documentElement.lang).toBe("vi");
  applyLocale("en");
  expect(document.documentElement.lang).toBe("en");
});

// --- LanguageToggle ---------------------------------------------------------

test("LanguageToggle renders an accessible VI/EN button", () => {
  const html = renderToStaticMarkup(<LanguageToggle />);
  expect(html).toContain('aria-label="Switch to Vietnamese"');
  expect(html).toContain(">VI<"); // shows the locale you can switch TO
});

// Client mount: zustand serves the initial state as the SSR snapshot, so a
// store flip must be proven with a real DOM click (same reason as auth-i18n).
test("clicking LanguageToggle flips the locale and mirrors <html lang>", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const { act } = await import("react");
  // react-dom/client is only resolvable through the web app's node_modules.
  const webDir = new URL("../apps/web/src/components/", import.meta.url).pathname;
  const { createRoot } = (await import(Bun.resolveSync("react-dom/client", webDir))) as {
    createRoot: (c: HTMLElement) => {
      render: (n: unknown) => void;
      unmount: () => void;
    };
  };
  useLocaleStore.getState().setLocale("en");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<LanguageToggle />));
  const click = (label: string) => {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!button) throw new Error(`missing button: ${label}`);
    act(() => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  };
  click("Switch to Vietnamese");
  expect(useLocaleStore.getState().locale).toBe("vi");
  expect(document.documentElement.lang).toBe("vi");
  click("Chuyển sang tiếng Anh");
  expect(useLocaleStore.getState().locale).toBe("en");
  expect(document.documentElement.lang).toBe("en");
  act(() => root.unmount());
  container.remove();
});
