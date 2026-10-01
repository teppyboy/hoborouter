// Models catalog data.
//
// Endpoint choice (documented decision): the dashboard uses
// GET /api/workspaces/:id/models — the only session-scoped endpoint returning
// published canonical models WITH per-1M prices for any signed-in workspace
// member (apps/api/src/routes/admin-models.ts:151). GET /api/admin/catalog/public
// is instance-admin only; it is used opportunistically to enrich rows with
// display_name/description/capabilities/context_window and is skipped on 403.
// Note: the session endpoint exposes input/output prices only (VND integers
// per 1M); cached/reasoning USD-micro prices have no session endpoint yet.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useWorkspaceStore } from "../../lib/workspace";

export interface WorkspaceModel {
  id: string;
  public_model: string;
  price_input_per_1m: number;
  price_output_per_1m: number;
  effective_at: number;
  snapshot_id: string | null;
}

interface CatalogExtra {
  public_id: string;
  display_name: string | null;
  description: string | null;
  capabilities: string[] | null;
  context_window: number | null;
}

/** A model row as shown in the dashboard (workspace prices + optional catalog enrichment). */
export interface CatalogModel {
  publicId: string;
  provider: string;
  name: string;
  priceInputPer1m: number;
  priceOutputPer1m: number;
  displayName: string | null;
  description: string | null;
  capabilities: string[] | null;
  contextWindow: number | null;
}

function parseCaps(v: unknown): string[] | null {
  if (Array.isArray(v) && v.every((c) => typeof c === "string")) return v as string[];
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) && p.every((c) => typeof c === "string") ? (p as string[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Published models + per-1M prices for the selected workspace. */
export function useWorkspaceModels() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  return useQuery({
    queryKey: ["workspace-models", workspaceId],
    queryFn: () => api<WorkspaceModel[]>(`/api/workspaces/${workspaceId}/models`),
    enabled: !!workspaceId,
  });
}

/** Optional admin-only enrichment; silently ignored for non-admins (403) or pre-merge (404). */
function useCatalogExtras(enabled: boolean) {
  return useQuery({
    queryKey: ["catalog-extras"],
    queryFn: () => api<CatalogExtra[]>("/api/admin/catalog/public"),
    enabled,
    retry: false,
  });
}

export function useCatalogModels(): {
  models: CatalogModel[];
  loading: boolean;
  error: string | null;
} {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const modelsQ = useWorkspaceModels();
  const extrasQ = useCatalogExtras(modelsQ.isSuccess);

  if (modelsQ.isPending && workspaceId) return { models: [], loading: true, error: null };
  if (modelsQ.isError)
    return { models: [], loading: false, error: modelsQ.error.message ?? "Failed to load models." };

  const extras = new Map(
    (Array.isArray(extrasQ.data) ? extrasQ.data : []).map((e) => [e.public_id, e]),
  );
  const models = (modelsQ.data ?? []).map((m): CatalogModel => {
    const [provider, ...rest] = m.public_model.split("/");
    const extra = extras.get(m.public_model);
    return {
      publicId: m.public_model,
      provider: rest.length
        ? (provider ?? "—")
        : (extra?.public_id.split("/")[0] ?? "") || "—",
      name: rest.join("/") || m.public_model,
      priceInputPer1m: m.price_input_per_1m,
      priceOutputPer1m: m.price_output_per_1m,
      displayName: extra?.display_name ?? null,
      description: extra?.description ?? null,
      capabilities: parseCaps(extra?.capabilities),
      contextWindow: extra?.context_window ?? null,
    };
  });
  return { models, loading: false, error: null };
}

export function allProviders(models: CatalogModel[]): string[] {
  return [...new Set(models.map((m) => m.provider))].sort();
}

export function allCapabilities(models: CatalogModel[]): string[] {
  return [...new Set(models.flatMap((m) => m.capabilities ?? []))].sort();
}
