import type { UsageLogRow } from "./api";

export const LOG_PAGE_SIZE = 25;

export interface LogFilters {
  search: string;
  model: string; // "all" or public_model
  status: string; // "all" | "ok" | "error"
  key: string; // "all" or key_prefix
}

function missingModel(r: UsageLogRow): boolean {
  return r.public_model == null || r.public_model.trim() === "";
}

/**
 * Visibility gate: hide requests with a missing model OR with both input and
 * output tokens 0 (no usage to show). One-sided nonzero rows and error rows
 * with usage are kept. Display-only — never deletes or mutates data.
 */
function isVisibleRequest(r: UsageLogRow): boolean {
  if (missingModel(r)) return false;
  if (r.input_tokens === 0 && r.output_tokens === 0) return false;
  return true;
}

/** Display-visible rows (visibility gate applied). */
export function visibleRows(rows: UsageLogRow[]): UsageLogRow[] {
  return rows.filter(isVisibleRequest);
}

/** Client-side filtering over the loaded page of logs (visibility-gated). */
export function applyLogFilters(rows: UsageLogRow[], f: LogFilters): UsageLogRow[] {
  const search = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (!isVisibleRequest(r)) return false;
    if (f.model !== "all" && r.public_model !== f.model) return false;
    if (f.status === "ok" && r.status !== "ok") return false;
    if (f.status === "error" && r.status === "ok") return false;
    if (f.key !== "all" && (r.key_prefix ?? "—") !== f.key) return false;
    if (
      search &&
      !`${r.request_id} ${r.public_model} ${r.provider} ${r.status} ${r.key_prefix ?? ""}`
        .toLowerCase()
        .includes(search)
    )
      return false;
    return true;
  });
}

export function paginateLogs(rows: UsageLogRow[], page: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / LOG_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  return {
    page: safePage,
    pageCount,
    slice: rows.slice(safePage * LOG_PAGE_SIZE, (safePage + 1) * LOG_PAGE_SIZE),
  };
}
