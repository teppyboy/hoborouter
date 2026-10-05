// Canonical model catalog helpers over the models / provider_model_mappings /
// model_prices tables. Pure typed Drizzle reads; no pricing hardcoded.
//
// Price semantics (documented decision): the CURRENT price is the row with the
// latest effective_at <= now AND retired_at IS NULL. Retiring is modeled by
// setting retired_at; future-effective rows are ignored. model_prices rows are
// never updated — a price change inserts a new row. DB triggers
// model_prices_no_update / model_prices_no_delete (migration 0003) enforce
// immutability at the storage layer.
import { and, desc, eq, exists, isNull, lte, sql } from "drizzle-orm";
import { modelPrices, models, providerModelMappings, type Db, type Tx } from "@hoborouter/db";

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
  /** Marks models resolvable by the hoborouter/auto cheapest-first router. */
  auto_eligible: boolean;
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
  auto_eligible: models.auto_eligible,
  prompt_caching: models.prompt_caching,
  created_at: models.created_at,
  updated_at: models.updated_at,
};

export async function getCurrentPrice(
  db: Db | Tx,
  modelId: string,
  now = Date.now(),
): Promise<PriceRow | null> {
  const rows = await db
    .select()
    .from(modelPrices)
    .where(
      and(
        eq(modelPrices.model_id, modelId),
        lte(modelPrices.effective_at, now),
        isNull(modelPrices.retired_at),
      ),
    )
    .orderBy(desc(modelPrices.effective_at), desc(modelPrices.id))
    .limit(1);
  return rows[0] ?? null;
}

/** Enabled AND published models having >=1 enabled mapping and a current price. */
export async function listPublicModels(db: Db | Tx, now = Date.now()): Promise<ModelRow[]> {
  return db
    .select(modelRowFields)
    .from(models)
    .where(
      and(
        eq(models.enabled, true),
        eq(models.published, true),
        exists(
          db
            .select({ x: providerModelMappings.model_id })
            .from(providerModelMappings)
            .where(
              and(
                eq(providerModelMappings.model_id, models.id),
                eq(providerModelMappings.enabled, true),
              ),
            ),
        ),
        exists(
          db
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
    .orderBy(models.public_id);
}

/** Resolve a public model id to its model, first enabled mapping, and current price. Requires enabled+published model. */
export async function resolveModel(
  db: Db | Tx,
  publicId: string,
  now = Date.now(),
): Promise<{ model: ModelRow; mapping: MappingRow; price: PriceRow } | null> {
  const modelRows = await db
    .select(modelRowFields)
    .from(models)
    .where(
      and(eq(models.public_id, publicId), eq(models.enabled, true), eq(models.published, true)),
    )
    .limit(1);
  const model = modelRows[0];
  if (!model) return null;
  const mappingRows = await db
    .select()
    .from(providerModelMappings)
    .where(
      and(eq(providerModelMappings.model_id, model.id), eq(providerModelMappings.enabled, true)),
    )
    .orderBy(providerModelMappings.created_at, providerModelMappings.id)
    .limit(1);
  const mapping = mappingRows[0];
  if (!mapping) return null;
  const price = await getCurrentPrice(db, model.id, now);
  if (!price) return null;
  return { model, mapping, price };
}

/** Canonical public id clients send to trigger cheapest-first automatic routing. */
export const AUTO_PUBLIC_ID = "hoborouter/auto";

/** Short alias accepted alongside the canonical auto public id. */
export const AUTO_ALIAS_ID = "auto";

/**
 * True when a client-supplied model id names the auto router (either public
 * alias). Alias ids are routing TRIGGERS, never routing TARGETS: resolveAutoModel
 * excludes every isAutoPublicId model from its candidate list so the router
 * can never select itself (or its alias) as the cheapest model.
 */
export function isAutoPublicId(id: string): boolean {
  return id === AUTO_PUBLIC_ID || id === AUTO_ALIAS_ID;
}

/**
 * Auto-routing candidates: auto_eligible models that are otherwise listed
 * (enabled + published + enabled mapping + current price), each with its
 * first enabled mapping and current price attached. Callers apply request
 * fit (context/capability), key permissions, and health filtering.
 */
export async function listAutoCandidates(
  db: Db | Tx,
  now = Date.now(),
): Promise<{ model: ModelRow; mapping: MappingRow; price: PriceRow }[]> {
  const rows = await db
    .select(modelRowFields)
    .from(models)
    .where(
      and(
        eq(models.auto_eligible, true),
        eq(models.enabled, true),
        eq(models.published, true),
        exists(
          db
            .select({ x: providerModelMappings.model_id })
            .from(providerModelMappings)
            .where(
              and(
                eq(providerModelMappings.model_id, models.id),
                eq(providerModelMappings.enabled, true),
              ),
            ),
        ),
        exists(
          db
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
    .orderBy(models.public_id);
  const out: { model: ModelRow; mapping: MappingRow; price: PriceRow }[] = [];
  for (const model of rows) {
    const mappingRows = await db
      .select()
      .from(providerModelMappings)
      .where(
        and(eq(providerModelMappings.model_id, model.id), eq(providerModelMappings.enabled, true)),
      )
      .orderBy(providerModelMappings.created_at, providerModelMappings.id)
      .limit(1);
    const mapping = mappingRows[0];
    if (!mapping) continue;
    const price = await getCurrentPrice(db, model.id, now);
    if (!price) continue;
    out.push({ model, mapping, price });
  }
  return out;
}
