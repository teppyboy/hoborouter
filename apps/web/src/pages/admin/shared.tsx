import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "../../components/ui/skeleton";
import { EmptyState, ErrorState } from "../../components/page";
import { ApiError, api } from "../../lib/api";

/** Raw model row from GET /api/v1/admin/catalog/models (bun:sqlite, capabilities is JSON string). */
export interface AdminModel {
  id: string;
  public_id: string;
  slug: string;
  display_name: string;
  provider: string;
  description: string | null;
  capabilities: string | null;
  context_window: number | null;
  enabled: number;
  published: number;
  has_price: number;
  has_mapping: number;
  created_at: number;
  updated_at: number;
}

export interface AuditRow {
  id: string;
  actor_user_id: string | null;
  workspace_id: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: number;
}

/**
 * Admin query helper: renders Skeleton / "Admin only" on 403 / ErrorState,
 * otherwise children with the data.
 */
export function useAdminQuery<T>(key: readonly unknown[], path: string) {
  return useQuery<T>({
    queryKey: key,
    queryFn: () => api<T>(path),
    retry: false,
  });
}

export function AdminGate({
  query,
  children,
}: {
  query: { isPending: boolean; error: unknown };
  children: React.ReactNode;
}) {
  if (query.isPending)
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-2/3" />
      </div>
    );
  if (query.error) {
    if (query.error instanceof ApiError && query.error.status === 403)
      return (
        <EmptyState title="Admin only" description="This page requires instance admin access." />
      );
    return <ErrorState message={query.error instanceof Error ? query.error.message : undefined} />;
  }
  return <>{children}</>;
}

/** "0.0015" -> 1500 micros exactly, via string math (no floats). Null if invalid. */
export function usdPer1mToMicro(input: string): number | null {
  const s = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  const [int, frac = ""] = s.split(".");
  const micro = BigInt(int + frac.padEnd(6, "0"));
  return micro <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micro) : null;
}

export function parseCapabilities(input: string): string[] {
  return input
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}
