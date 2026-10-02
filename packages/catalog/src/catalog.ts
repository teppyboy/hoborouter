// Canonical model catalog helpers over the models / provider_model_mappings /
// model_prices tables. Pure typed Drizzle reads; no pricing hardcoded.
//
// Price semantics (documented decision): the CURRENT price is the row with the
// latest effective_at <= now AND retired_at IS NULL. Retiring is modeled by
// setting retired_at; future-effective rows are ignored. model_prices rows are
// never updated — a price change inserts a new row. DB triggers
// model_prices_no_update / model_prices_no_delete (migration 0003) enforce
// immutability at the storage layer.
import type { Database } from "bun:sqlite";
import { and, desc, eq, exists, isNull, lte, sql } from "drizzle-orm";
import { modelPrices, models, orm, providerModelMappings } from "@hoborouter/db";

export type ModelRow = {
  id: string;
  public_id: string;
  slug: string;
  display_name: string;
  provider: string;
  description: string | null;
  capabilities: string[] | null;
  context_window: number | null;
  enabled: boolean;
  published: boolean;
  /** 'inherit' (follows global prompt_caching_enabled) | 'on' | 'off'. */
  prompt_caching: string;
  created_at: number;
  updated_at: number;
};

export type MappingRow = {
  id: string;
  model_id: string;
  provider: string;
  upstream_model: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
};

export type PriceRow = {
  id: string;
  model_id: string;
  input_usd_micro_per_1m: number;
  output_usd_micro_per_1m: number;
  cached_input_usd_micro_per_1m: number;
  reasoning_usd_micro_per_1m: number;
  markup_ppm: number;
  effective_at: number;
  retired_at: number | null;
};

const modelRowFields = {
  id: models.id,
  public_id: models.public_id,
  slug: models.slug,
  display_name: models.display_name,
  provider: models.provider,
  description: models.description,
  // capabilities stored as JSON text; schema leaves it `unknown`, callers want string[].
  capabilities: sql<string[] | null>`${models.capabilities}`,
  context_window: models.context_window,
  enabled: models.enabled,
  published: models.published,
  prompt_caching: models.prompt_caching,
  created_at: models.created_at,
  updated_at: models.updated_at,
};

export function getCurrentPrice(db: Database, modelId: string, now = Date.now()): PriceRow | null {
  return (
    orm(db)
      .select()
      .from(modelPrices)
      .where(and(eq(modelPrices.model_id, modelId), lte(modelPrices.effective_at, now), isNull(modelPrices.retired_at)))
      .orderBy(desc(modelPrices.effective_at), desc(modelPrices.id))
      .limit(1)
      .get() ?? null
  );
}

/** Enabled AND published models having >=1 enabled mapping and a current price. */
export function listPublicModels(db: Database, now = Date.now()): ModelRow[] {
  const db0 = orm(db);
  return db0
    .select(modelRowFields)
    .from(models)
    .where(
      and(
        eq(models.enabled, true),
        eq(models.published, true),
        exists(
          db0
            .select({ x: providerModelMappings.model_id })
            .from(providerModelMappings)
            .where(and(eq(providerModelMappings.model_id, models.id), eq(providerModelMappings.enabled, true))),
        ),
        exists(
          db0
            .select({ x: modelPrices.model_id })
            .from(modelPrices)
            .where(
              and(
                eq(modelPrices.model_id, models.id),
                lte(modelPrices.effective_at, now),
                isNull(modelPrices.retired_at),
              ),
            ),
        ),
      ),
    )
    .orderBy(models.public_id)
    .all();
}

/** Resolve a public model id to its model, first enabled mapping, and current price. Requires enabled+published model. */
export function resolveModel(
  db: Database,
  publicId: string,
  now = Date.now(),
): { model: ModelRow; mapping: MappingRow; price: PriceRow } | null {
  const model = orm(db)
    .select(modelRowFields)
    .from(models)
    .where(and(eq(models.public_id, publicId), eq(models.enabled, true), eq(models.published, true)))
    .get();
  if (!model) return null;
  const mapping = orm(db)
    .select()
    .from(providerModelMappings)
    .where(and(eq(providerModelMappings.model_id, model.id), eq(providerModelMappings.enabled, true)))
    .orderBy(providerModelMappings.created_at, providerModelMappings.id)
    .limit(1)
    .get();
  if (!mapping) return null;
  const price = getCurrentPrice(db, model.id, now);
  if (!price) return null;
  return { model, mapping, price };
}
