import { useCallback } from "react";
import { useLocaleStore, type Locale } from "./locale";

/** Every dictionary key must provide both languages at compile time — no runtime key is ever missing. */
export interface LocaleEntry {
  en: string;
  vi: string;
}

/**
 * Pure translation: outside React components use
 * `translate(dict, key, useLocaleStore.getState().locale, vars)` explicitly.
 * Placeholder `{name}` is replaced by literal string substitution — var values
 * are inserted as plain text, never parsed as HTML, and never interpolated into
 * a RegExp, so a var like `$&` or `(a)` cannot corrupt the output.
 */
export function translate<const D extends Record<string, LocaleEntry>>(
  dictionary: D,
  key: Extract<keyof D, string>,
  locale: Locale,
  vars?: Record<string, string | number>,
): string {
  const entry = dictionary[key];
  // Typed dicts always have both strings; the fallbacks only guard runtime data
  // (missing key or missing locale string falls back to English).
  let text = entry ? (entry[locale] ?? entry.en) : (dictionary[key]?.en ?? key);
  if (!vars) return text;
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value === "string" || typeof value === "number") {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** Reactive `translate` bound to the locale store. Use inside components only. */
export function useT<const D extends Record<string, LocaleEntry>>(
  dictionary: D,
): (key: Extract<keyof D, string>, vars?: Record<string, string | number>) => string {
  const locale = useLocaleStore((s) => s.locale);
  return useCallback(
    (key: Extract<keyof D, string>, vars?: Record<string, string | number>) =>
      translate(dictionary, key, locale, vars),
    [dictionary, locale],
  );
}
