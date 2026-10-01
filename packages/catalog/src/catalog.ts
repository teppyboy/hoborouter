// Canonical model catalog helpers over the models / provider_model_mappings /
// model_prices tables. Pure reads on bun:sqlite; no pricing hardcoded.
//
// Price semantics (documented decision): the CURRENT price is the row with the
// latest effective_at <= now AND retired_at IS NULL. Retiring is modeled by
// setting retired_at; future-effective rows are ignored. model_prices rows are
// never updated — a price change inserts a new row. DB triggers
// model_prices_no_update / model_prices_no_delete (migration 0003) enforce
// immutability at the storage layer.
import type { Database } from "bun:sqlite";

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

export function getCurrentPrice(db: Database, modelId: string, now = Date.now()): PriceRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM model_prices WHERE model_id = ? AND effective_at <= ? AND retired_at IS NULL ORDER BY effective_at DESC, id DESC LIMIT 1",
      )
      .get(modelId, now) as PriceRow | undefined) ?? null
  );
}

/** Enabled AND published models having >=1 enabled mapping and a current price. */
export function listPublicModels(db: Database, now = Date.now()): ModelRow[] {
  return db
    .prepare(
      `SELECT m.* FROM models m
       WHERE m.enabled = 1 AND m.published = 1
         AND EXISTS (SELECT 1 FROM provider_model_mappings pm WHERE pm.model_id = m.id AND pm.enabled = 1)
         AND EXISTS (SELECT 1 FROM model_prices p WHERE p.model_id = m.id AND p.effective_at <= ? AND p.retired_at IS NULL)
       ORDER BY m.public_id`,
    )
    .all(now) as ModelRow[];
}

/** Resolve a public model id to its model, first enabled mapping, and current price. Requires enabled+published model. */
export function resolveModel(
  db: Database,
  publicId: string,
  now = Date.now(),
): { model: ModelRow; mapping: MappingRow; price: PriceRow } | null {
  const model = db
    .prepare("SELECT * FROM models WHERE public_id = ? AND enabled = 1 AND published = 1")
    .get(publicId) as ModelRow | undefined;
  if (!model) return null;
  const mapping = db
    .prepare(
      "SELECT * FROM provider_model_mappings WHERE model_id = ? AND enabled = 1 ORDER BY created_at, id LIMIT 1",
    )
    .get(model.id) as MappingRow | undefined;
  if (!mapping) return null;
  const price = getCurrentPrice(db, model.id, now);
  if (!price) return null;
  return { model, mapping, price };
}
