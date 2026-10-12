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
import {
  modelReasoningRoutes,
  modelPrices,
  models,
  providerModelMappings,
  REASONING_EFFORTS,
  type Db,
  type ReasoningEffort,
  type Tx,
} from "@hoborouter/db";

export { REASONING_EFFORTS };
export type { ReasoningEffort };

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

/** One catalog-authored public-effort -> CPA-compatible upstream mapping. */
export type ReasoningRouteMapping = {
  public_effort: ReasoningEffort;
  provider: string;
  upstream_model: string;
  upstream_effort: ReasoningEffort;
};

/** Enabled reasoning metadata for one model (gateway consumers). */
export type ReasoningMetadata = {
  model_id: string;
  default_effort: ReasoningEffort | null;
  routes: ReasoningRouteMapping[];
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
 * Enabled reasoning metadata for one model: the authored default effort plus
 * every enabled public-effort route (oldest first). Always returns a value;
 * a model with no authored routes and no default behaves as "no metadata"
 * (callers pass reasoning requests through to CPA untouched).
 */
export async function getReasoningMetadata(
  db: Db | Tx,
  modelId: string,
): Promise<ReasoningMetadata> {
  const modelRows = await db
    .select({ default_effort: models.default_reasoning_effort })
    .from(models)
    .where(eq(models.id, modelId))
    .limit(1);
  const routeRows = await db
    .select({
      public_effort: modelReasoningRoutes.public_effort,
      provider: modelReasoningRoutes.provider,
      upstream_model: modelReasoningRoutes.upstream_model,
      upstream_effort: modelReasoningRoutes.upstream_effort,
    })
    .from(modelReasoningRoutes)
    .where(and(eq(modelReasoningRoutes.model_id, modelId), eq(modelReasoningRoutes.enabled, true)))
    .orderBy(modelReasoningRoutes.created_at, modelReasoningRoutes.id);
  return {
    model_id: modelId,
    default_effort: modelRows[0]?.default_effort ?? null,
    routes: routeRows,
  };
}

export type ReasoningValidation =
  | { ok: true; effort: ReasoningEffort | null; route: ReasoningRouteMapping | null }
  | {
      ok: false;
      code: "invalid_reasoning" | "conflicting_reasoning" | "unsupported_reasoning";
      message: string;
    };

const reasoningError = (
  code: "invalid_reasoning" | "conflicting_reasoning" | "unsupported_reasoning",
  message: string,
): ReasoningValidation => ({ ok: false, code, message });

function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === "string" && (REASONING_EFFORTS as readonly string[]).includes(v);
}

function routeFor(metadata: ReasoningMetadata, effort: ReasoningEffort): ReasoningValidation {
  const route = metadata.routes.find((r) => r.public_effort === effort) ?? null;
  if (route) return { ok: true, effort, route };
  // A disable request ('none') with no authored 'none' route passes through:
  // the client explicitly asked for NO reasoning, so the upstream default is
  // the honest outcome. Any other unrouted effort is unsupported and must
  // fail BEFORE reservation.
  if (effort === "none") return { ok: true, effort, route: null };
  return reasoningError(
    "unsupported_reasoning",
    `Reasoning effort '${effort}' is not supported by this model`,
  );
}

/**
 * Resolve the reasoning intent carried by a request body against catalog
 * route metadata. Accepted equivalent forms (any protocol):
 * - OpenRouter: `reasoning: { effort }` / `{ enabled }` ({ max_tokens } is
 *   rejected: catalog routes are effort-keyed)
 * - OpenAI: `reasoning_effort` (chat) / `reasoning: { effort }` (responses)
 * - Anthropic: `thinking: { type: "enabled", budget_tokens }` (rejected,
 *   effort-keyed catalog) / `{ type: "adaptive" }` / `{ type: "disabled" }`,
 *   `output_config.effort`
 * Distinct efforts across forms conflict; identical restatements are fine.
 * With no metadata (or an empty one) any well-formed request passes through
 * unchanged — CPA owns conversion for un-authored models.
 */
export function validateReasoningRequest(
  body: Record<string, unknown>,
  metadata: ReasoningMetadata | null,
): ReasoningValidation {
  const efforts: ReasoningEffort[] = [];
  let enableCount = 0;
  let budgetSource: string | null = null;

  const reasoning = body.reasoning;
  if (reasoning !== undefined && reasoning !== null) {
    if (typeof reasoning !== "object" || Array.isArray(reasoning))
      return reasoningError("invalid_reasoning", "'reasoning' must be an object");
    const r = reasoning as Record<string, unknown>;
    const hasEffort = r.effort !== undefined && r.effort !== null;
    const hasBudget = r.max_tokens !== undefined && r.max_tokens !== null;
    if (hasEffort && hasBudget)
      return reasoningError(
        "conflicting_reasoning",
        "'reasoning.effort' and 'reasoning.max_tokens' are mutually exclusive",
      );
    if (hasEffort) {
      if (!isReasoningEffort(r.effort))
        return reasoningError(
          "invalid_reasoning",
          "'reasoning.effort' is not a supported reasoning effort",
        );
      efforts.push(r.effort);
    } else if (hasBudget) {
      if (
        typeof r.max_tokens !== "number" ||
        !Number.isSafeInteger(r.max_tokens) ||
        r.max_tokens < 1
      )
        return reasoningError(
          "invalid_reasoning",
          "'reasoning.max_tokens' must be a positive integer",
        );
      budgetSource = "reasoning.max_tokens";
    } else if (r.enabled === true) enableCount++;
    else if (r.enabled === false) efforts.push("none");
  }
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null) {
    if (!isReasoningEffort(body.reasoning_effort))
      return reasoningError(
        "invalid_reasoning",
        "'reasoning_effort' is not a supported reasoning effort",
      );
    efforts.push(body.reasoning_effort);
  }
  const thinking = body.thinking;
  if (thinking !== undefined && thinking !== null) {
    if (typeof thinking !== "object" || Array.isArray(thinking))
      return reasoningError("invalid_reasoning", "'thinking' must be an object");
    const th = thinking as Record<string, unknown>;
    if (th.type === "enabled") {
      const budget = th.budget_tokens;
      if (budget === undefined || budget === null)
        return reasoningError(
          "invalid_reasoning",
          "'thinking.budget_tokens' is required when thinking is enabled",
        );
      if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < 1)
        return reasoningError(
          "invalid_reasoning",
          "'thinking.budget_tokens' must be a positive integer",
        );
      budgetSource = "thinking.budget_tokens";
    } else if (th.type === "adaptive") enableCount++;
    else if (th.type === "disabled") efforts.push("none");
    else
      return reasoningError(
        "invalid_reasoning",
        "'thinking.type' must be 'enabled', 'adaptive', or 'disabled'",
      );
  }
  const outputConfig = body.output_config;
  if (outputConfig !== undefined && outputConfig !== null) {
    if (typeof outputConfig !== "object" || Array.isArray(outputConfig))
      return reasoningError("invalid_reasoning", "'output_config' must be an object");
    const oc = outputConfig as Record<string, unknown>;
    if (oc.effort !== undefined && oc.effort !== null) {
      if (!isReasoningEffort(oc.effort))
        return reasoningError(
          "invalid_reasoning",
          "'output_config.effort' is not a supported reasoning effort",
        );
      efforts.push(oc.effort);
    }
  }

  const distinct = [...new Set(efforts)];
  const effort = distinct[0] ?? null;
  const authored =
    metadata !== null && (metadata.routes.length > 0 || metadata.default_effort !== null);
  if (distinct.length > 1)
    return reasoningError(
      "conflicting_reasoning",
      "Request carries conflicting reasoning forms with different efforts",
    );
  if (budgetSource !== null) {
    if (distinct.length > 0 || enableCount > 0)
      return reasoningError(
        "conflicting_reasoning",
        "Reasoning budget forms cannot be combined with effort forms",
      );
    // Un-authored model: the gateway has no effort contract, CPA owns the
    // conversion, so the budget form passes through verbatim (pre-change
    // behavior). Authored models are effort-keyed and reject it.
    if (!authored) return { ok: true, effort: null, route: null };
    return reasoningError(
      "unsupported_reasoning",
      `Reasoning budget form '${budgetSource}' is not supported; send an effort instead`,
    );
  }

  if (effort === null) {
    if (enableCount === 0) return { ok: true, effort: null, route: null };
    // Reasoning enabled without an effort resolves the catalog default.
    if (!authored) return { ok: true, effort: null, route: null };
    if (metadata?.default_effort === null)
      return reasoningError(
        "unsupported_reasoning",
        "Model has no default reasoning effort; send an explicit effort",
      );
    return routeFor(metadata as ReasoningMetadata, metadata?.default_effort as ReasoningEffort);
  }
  if (!authored) return { ok: true, effort, route: null };
  return routeFor(metadata as ReasoningMetadata, effort);
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
