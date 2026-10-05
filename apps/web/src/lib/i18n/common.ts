import { useT } from "./t";

/**
 * Shared strings used across page groups. Area dictionaries live next to their
 * page group (e.g. `pages/public/public-dict.ts`) — add here ONLY strings that
 * genuinely repeat across areas, to avoid key-collision churn.
 */
export const common = {
  language: { en: "Language", vi: "Ngôn ngữ" },
  loading: { en: "Loading…", vi: "Đang tải…" },
  close: { en: "Close", vi: "Đóng" },
} as const;

export function useCommonT() {
  return useT(common);
}
