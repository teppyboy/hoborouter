// Capability label helper (display-only; output is never sent back to the API).
//
// Canonical metadata keys mirror gateway truth (apps/api/src/auto-resolve.ts):
// "chat" is required for every gateway request, "vision"/"tools" gate
// non-chat requests. Stored values outside this set are never renamed,
// dropped, or reinterpreted — they render verbatim. Absent capabilities are
// unknown: no capability is ever inferred (chat-capability of null-caps
// models is a gateway convention, not a stored claim, so the UI must not
// display it).
import type { LocaleEntry } from "./i18n/t";
import { useLocaleStore, type Locale } from "./i18n/locale";

export const KNOWN_CAPABILITIES = ["chat", "vision", "tools", "reasoning"] as const;
export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

const KNOWN_LABELS: Record<KnownCapability, LocaleEntry> = {
  chat: { en: "Chat", vi: "Chat" },
  vision: { en: "Vision", vi: "Nhận diện ảnh" },
  tools: { en: "Tools", vi: "Công cụ" },
  reasoning: { en: "Reasoning", vi: "Suy luận" },
};

/** Case-sensitive on purpose: "Chat" authored upstream stays verbatim. */
export function isKnownCapability(value: string): value is KnownCapability {
  return (KNOWN_CAPABILITIES as readonly string[]).includes(value);
}

/** Bilingual label for known keys; verbatim stored value for unknown ones. */
export function capabilityLabel(value: string, locale: Locale): string {
  return isKnownCapability(value) ? KNOWN_LABELS[value][locale] : value;
}

/** Reactive variant for components. */
export function useCapabilityLabel(): (value: string) => string {
  const locale = useLocaleStore((s) => s.locale);
  return (value) => capabilityLabel(value, locale);
}

/**
 * Filter options from distinct stored values: known keys first (canonical
 * order), unknown values after (alphabetical, verbatim). Filtering itself
 * always matches the verbatim stored value, never the label.
 */
export function capabilityFilterOptions(values: Iterable<string>): string[] {
  const present = new Set(values);
  const known = KNOWN_CAPABILITIES.filter((c) => present.has(c));
  const unknown = [...present].filter((c) => !isKnownCapability(c)).sort();
  return [...known, ...unknown];
}
