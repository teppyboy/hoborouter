// Models catalog data — public catalog endpoints (session-scoped).
// GET /api/v1/catalog/models and /api/v1/catalog/models/:publicId.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

export interface CatalogPrice {
  input_usd_micro_per_1m: number;
  output_usd_micro_per_1m: number;
  cached_input_usd_micro_per_1m: number;
  reasoning_usd_micro_per_1m: number;
}

export interface CatalogModelItem {
  id: string;
  public_id: string;
  display_name: string | null;
  provider: string;
  description: string | null;
  capabilities: string[];
  context_window: number | null;
  price: CatalogPrice;
}

export interface CatalogModel {
  id: string;
  publicId: string;
  provider: string;
  displayName: string | null;
  description: string | null;
  capabilities: string[];
  contextWindow: number | null;
  price: CatalogPrice;
}

/** Public model catalog for any signed-in user. */
export function useCatalogModels(): {
  models: CatalogModel[];
  loading: boolean;
  error: string | null;
} {
  const q = useQuery({
    queryKey: ["catalog-models"],
    queryFn: () => api<{ data: CatalogModelItem[] }>("/api/v1/catalog/models"),
  });

  if (q.isPending) return { models: [], loading: true, error: null };
  if (q.isError)
    return { models: [], loading: false, error: q.error.message ?? "Failed to load models." };

  const models = (q.data?.data ?? []).map((m): CatalogModel => ({
    id: m.id,
    publicId: m.public_id,
    provider: m.provider,
    displayName: m.display_name,
    description: m.description,
    capabilities: m.capabilities ?? [],
    contextWindow: m.context_window,
    price: m.price,
  }));
  return { models, loading: false, error: null };
}

/** Single public model by public id (may contain '/'; encoded). */
export function useCatalogModel(publicId: string) {
  return useQuery({
    queryKey: ["catalog-models", publicId],
    queryFn: () =>
      api<CatalogModelItem>(`/api/v1/catalog/models/${encodeURIComponent(publicId)}`),
    enabled: !!publicId,
  });
}

export function allProviders(models: CatalogModel[]): string[] {
  return [...new Set(models.map((m) => m.provider))].sort();
}

export function allCapabilities(models: CatalogModel[]): string[] {
  return [...new Set(models.flatMap((m) => m.capabilities))].sort();
}
