// Queries + types for the unauthenticated public pages (landing, pricing,
// quickstart). Contracts owned by the public API worker:
//   GET /api/v1/public/instance  -> name, api_base_url, support links
//   GET /api/v1/public/catalog   -> published models, prices already converted
//                                   to VND by the same catalog helpers billing
//                                   uses (never a second price path client-side)
//   GET /api/v1/public/subscription-plans -> active plans (PROPOSED: the
//                                   existing /api/v1/subscription-plans
//                                   requires a session; see parent coord note)
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface PublicSupportLinks {
  email?: string | null;
  telegram?: string | null;
  facebook?: string | null;
  threads?: string | null;
}

export interface PublicInstance {
  name: string;
  /** Trusted admin-configured gateway base URL used in code snippets. */
  api_base_url: string;
  support: PublicSupportLinks;
}

/** VND per 1M tokens, converted server-side with the billing exchange rate + markup. */
export interface PublicModelPriceVnd {
  input: number;
  output: number;
  cached_input: number;
  reasoning: number;
}

export interface PublicCatalogModel {
  public_id: string;
  display_name: string;
  provider: string;
  description: string;
  capabilities: string[];
  context_window: number;
  price_vnd_per_1m: PublicModelPriceVnd;
}

export interface PublicSubscriptionPlan {
  id: string;
  name: string;
  price_vnd: number;
  credit_per_period_vnd: number;
  period_days: number;
  rate_limit_per_minute?: number;
  /** Authored exact USD price text; null on legacy VND rows. */
  price_usd?: string | null;
  credit_per_period_usd?: string | null;
}

export function usePublicInstance() {
  return useQuery({
    queryKey: ["public", "instance"],
    queryFn: () => api<PublicInstance>("/api/v1/public/instance"),
    staleTime: 60_000,
    retry: false,
  });
}

export function usePublicCatalog() {
  return useQuery({
    queryKey: ["public", "catalog"],
    queryFn: () => api<{ data: PublicCatalogModel[] }>("/api/v1/public/catalog"),
    staleTime: 60_000,
    retry: false,
  });
}

export function usePublicPlans() {
  return useQuery({
    queryKey: ["public", "plans"],
    queryFn: () => api<{ data: PublicSubscriptionPlan[] }>("/api/v1/public/subscription-plans"),
    staleTime: 60_000,
    retry: false,
  });
}
