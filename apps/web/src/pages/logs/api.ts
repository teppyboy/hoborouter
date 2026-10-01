import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

/**
 * Endpoint contracts assumed (backend: apps/api/src/routes/dashboard.ts):
 *
 * GET /api/workspaces/:id/usage-logs?limit=50&before=<created_at_ms>
 *   -> { data: UsageLogRow[] }   (created_at DESC, cursor pagination via `before`)
 *
 * GET /api/workspaces/:id/usage-summary?days=30
 *   -> { totals: { requests, spend_vnd, input_tokens, output_tokens, errors },
 *        daily: [{ day: "YYYY-MM-DD", requests, spend_vnd, tokens }],
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
  upstream_model: string | null;
  provider: string;
  status: string;
  failure: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number;
  charged_vnd: number;
  latency_ms: number;
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
  };
  daily: { day: string; requests: number; spend_vnd: number; tokens: number }[];
  by_model: { public_model: number | string; requests: number; spend_vnd: number; tokens: number }[];
}

export function useRequestLogs(workspaceId: string | null, limit = 100) {
  return useQuery({
    queryKey: ["usage-logs", workspaceId, limit],
    queryFn: () =>
      api<{ data: UsageLogRow[] }>(
        `/api/workspaces/${workspaceId}/usage-logs?limit=${limit}`,
      ).then((r) => r.data),
    enabled: workspaceId != null,
    staleTime: 15_000,
    retry: (count, err) => {
      const status = (err as { status?: number }).status;
      return status !== 404 && count < 2;
    },
  });
}

export function useUsageSummary(workspaceId: string | null, days = 30) {
  return useQuery({
    queryKey: ["usage-summary", workspaceId, days],
    queryFn: () =>
      api<UsageSummary>(
        `/api/workspaces/${workspaceId}/usage-summary?days=${days}`,
      ),
    enabled: workspaceId != null,
    staleTime: 15_000,
    retry: (count, err) => {
      const status = (err as { status?: number }).status;
      return status !== 404 && count < 2;
    },
  });
}
