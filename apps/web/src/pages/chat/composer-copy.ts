import { useT } from "../../lib/i18n/t";
import { chatCopy } from "./copy";

/** Composer-owned copy additions. Kept out of copy.ts (shared with other
 *  lanes); the composer dictionary merges both so every existing chat-page
 *  key keeps resolving while new composer strings live here. */
export const composerCopy = {
  advanced: { en: "Advanced", vi: "Nâng cao" },
  advancedHint: {
    en: "Scope, billing and attachment details",
    vi: "Chi tiết phạm vi, tính phí và tệp đính kèm",
  },
  scopeBilling: {
    en: "Usage is charged to your selected workspace.",
    vi: "Mức sử dụng được tính vào workspace bạn đã chọn.",
  },
  searchModels: { en: "Search models…", vi: "Tìm mô hình…" },
  searchModelsLabel: { en: "Search models", vi: "Tìm mô hình" },
  noModelsFound: {
    en: "No models match your search.",
    vi: "Không có mô hình phù hợp.",
  },
} as const;

export const composerDict = { ...chatCopy, ...composerCopy } as typeof chatCopy &
  typeof composerCopy;

export const useComposerT = () => useT(composerDict);
