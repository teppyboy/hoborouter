import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

/**
 * Endpoint contracts assumed (backend: apps/api/src/routes/dashboard.ts):
 *
 * GET /api/v1/workspaces/:id/usage-logs?limit=50&before=<created_at_ms>
 *   -> { data: UsageLogRow[] }   (created_at DESC, cursor pagination via `before`)
 *
 * GET /api/v1/workspaces/:id/usage-summary?days=30&model=<public_model>
 *   -> { totals: { requests, spend_vnd, input_tokens, output_tokens, errors,
 *        visible_requests?, visible_errors? },
 *        daily: [{ day: "YYYY-MM-DD", requests, spend_vnd, tokens, errors }],
 *        by_model: [{ public_model, requests, spend_vnd, tokens }] }
 *
 * On 404 (endpoint not merged yet) pages render an honest empty state.
 */

export interface UsageLogRow {
  id: string;
  request_id: string;
  /** Epoch milliseconds */
  created_at: number;
  public_model: string;
  provider: string;
  status: string;
  failure: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number;
  charged_vnd: number;
  latency_ms: number | null;
  ttft_ms: number | null;
  key_prefix: string | null;
}

export interface UsageSummary {
  totals: {
    requests: number;
    spend_vnd: number;
    input_tokens: number;
    output_tokens: number;
    errors: number;
    /** Visibility-gated counts (backend adds them); undefined on older backend. */
    visible_requests?: number;
    visible_errors?: number;
  };
  daily: { day: string; requests: number; spend_vnd: number; tokens: number; errors: number }[];
  by_model: {
    public_model: number | string;
    requests: number;
    spend_vnd: number;
    tokens: number;
  }[];
}

/** Success rate label over visibility-gated rows — same rule as Overview.
 *  Em dash when counts are absent (older backend) or denominator is zero. */
export function successRateLabel(visibleRequests?: number, visibleErrors?: number): string {
  if (visibleRequests == null || visibleErrors == null || visibleRequests <= 0) return "—";
  return `${(((visibleRequests - visibleErrors) / visibleRequests) * 100).toFixed(1)}%`;
}

export function useRequestLogs(workspaceId: string | null, limit = 100) {
  return useQuery({
    queryKey: ["usage-logs", workspaceId, limit],
    queryFn: ({ signal }) =>
      api<{ data: UsageLogRow[] }>(`/api/v1/workspaces/${workspaceId}/usage-logs?limit=${limit}`, {
        signal,
      }).then((r) => r.data),
    enabled: workspaceId != null,
    staleTime: 15_000,
    retry: (count, err) => {
      const status = (err as { status?: number }).status;
      // 401/403 are auth states, not transient: retrying only adds dead-cookie
      // noise on logout.
      return status !== 404 && status !== 401 && status !== 403 && count < 2;
    },
  });
}

export function useUsageSummary(workspaceId: string | null, days = 30, model?: string) {
  return useQuery({
    queryKey: ["usage-summary", workspaceId, days, model ?? null],
    queryFn: ({ signal }) =>
      api<UsageSummary>(
        `/api/v1/workspaces/${workspaceId}/usage-summary?days=${days}${
          model ? `&model=${encodeURIComponent(model)}` : ""
        }`,
        { signal },
      ),
    enabled: workspaceId != null,
    staleTime: 15_000,
    retry: (count, err) => {
      const status = (err as { status?: number }).status;
      // 401/403 are auth states, not transient: retrying only adds dead-cookie
      // noise on logout.
      return status !== 404 && status !== 401 && status !== 403 && count < 2;
    },
  });
}
