// Canonical catalog admin API — instance-admin only (same authz as
// admin-models.ts). Every mutation writes an audit row atomically in the same
// transaction. model_prices rows are immutable: a price change inserts a NEW
// row with effective_at = server time; old rows are never updated.
import { Elysia, t } from "elysia";
import type { Db, Tx } from "@hoborouter/db";import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit, jsonError } from "../authz";
import { MAX_SAFE_INTEGER_MONEY } from "@hoborouter/db";
import { sql, type SQL } from "drizzle-orm";
import { getCurrentPrice, listPublicModels } from "@hoborouter/catalog";

// Bare lowercase slug, or `provider/name`, lowercase slug chars ([a-z0-9-]).
const PUBLIC_ID_RE = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRICE_FIELDS = [
  "input_usd_micro_per_1m",
  "output_usd_micro_per_1m",
  "cached_input_usd_micro_per_1m",
  "reasoning_usd_micro_per_1m",
  "markup_ppm",
] as const;

function isSlug(v: unknown): v is string {
  return typeof v === "string" && SLUG_RE.test(v);
}

/** Row-fetch helper for raw SQL reads; connection-level execute wraps rows in { rows }. */
async function rawRows<T>(db: Db | Tx, query: SQL): Promise<T[]> {
  const result: unknown = await db.execute(query);
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

// Bun SQL returns int8 columns (epoch-ms, money) as strings; coerce known
// numeric fields so JSON responses keep number types.
const NUMERIC_FIELDS = new Set([
  "created_at",
  "updated_at",
  "effective_at",
  "retired_at",
  "context_window",
  "input_usd_micro_per_1m",
  "output_usd_micro_per_1m",
  "cached_input_usd_micro_per_1m",
  "reasoning_usd_micro_per_1m",
  "markup_ppm",
]);
function coerceNums<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => coerceNums(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] =
        NUMERIC_FIELDS.has(k) && typeof v === "string" ? Number(v) : coerceNums(v);
    return out as unknown as T;
  }
  return value;
}

async function modelExists(db: Db | Tx, id: string): Promise<boolean> {
  return (await rawRows(db, sql`SELECT 1 FROM models WHERE id = ${id}`)).length > 0;
}

function parseCaps(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((c) => typeof c === "string") ? (v as string[]) : null;
}

/** Non-negative safe integer within the canonical money bound. */
function isMoney(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_SAFE_INTEGER_MONEY;
}

function validateModelBody(b: Record<string, unknown>): string | null {
  if (typeof b.public_id !== "string" || !PUBLIC_ID_RE.test(b.public_id))
    return "public_id must be a lowercase slug or '<provider>/<name>'";
  if (!isSlug(b.slug)) return "slug must be lowercase slug chars";
  if (typeof b.display_name !== "string" || !b.display_name.trim())
    return "display_name is required";
  if (typeof b.provider !== "string" || !b.provider.trim()) return "provider is required";
  if (b.capabilities !== null && b.capabilities !== undefined) {
    if (!Array.isArray(b.capabilities) || b.capabilities.some((c) => typeof c !== "string"))
      return "capabilities must be an array of strings";
  }
  if (
    b.context_window !== null &&
    b.context_window !== undefined &&
    (typeof b.context_window !== "number" ||
      !Number.isSafeInteger(b.context_window) ||
      b.context_window <= 0)
  )
    return "context_window must be a positive integer or null";
  if (
    b.prompt_caching !== undefined &&
    b.prompt_caching !== null &&
    b.prompt_caching !== "inherit" &&
    b.prompt_caching !== "on" &&
    b.prompt_caching !== "off"
  )
    return "prompt_caching must be 'inherit', 'on', or 'off'";
  return null;
}

/**
 * One route per model: disable all currently enabled mappings, then insert a
 * new enabled one (history preserved — old rows keep their ids because
 * requests.provider_model_mapping_id and billing settlement reference them).
 * No-op when the enabled route already matches.
 */
async function setModelRoute(
  db: Db,
  modelId: string,
  upstreamModel: string,
  provider: string,
  userId: string,
): Promise<{ changed: boolean; mappingId: string | null }> {
  const currentRows = await rawRows<{ id: string; provider: string; upstream_model: string }>(
    db,
    sql`SELECT id, provider, upstream_model FROM provider_model_mappings WHERE model_id = ${modelId} AND enabled = true ORDER BY created_at ASC, id ASC LIMIT 1`,
  );
  const current = currentRows[0];
  if (current && current.upstream_model === upstreamModel && current.provider === provider)
    return { changed: false, mappingId: current.id };
  const id = crypto.randomUUID();
  const now = Date.now();
  const before = current
    ? { id: current.id, provider: current.provider, upstream_model: current.upstream_model }
    : null;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE provider_model_mappings SET enabled = false, updated_at = ${now} WHERE model_id = ${modelId} AND enabled = true`,
    );
    await tx.execute(
      sql`INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES (${id}, ${modelId}, ${provider}, ${upstreamModel}, true, ${now}, ${now})`,
    );
    await writeAudit(tx, {
      actorUserId: userId,
      workspaceId: null,
      action: "catalog.route.update",
      target: modelId,
      detail: { before, after: { provider, upstream_model: upstreamModel, mapping_id: id } },
    });
  });
  return { changed: true, mappingId: id };
}

export const adminCatalogRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-catalog" })
    .post(
      "/api/v1/admin/catalog/models",
      {
        body: t.Optional(t.Record(t.String(), t.Any())),
        detail: {
          tags: ["Catalog"],
          summary: "Create catalog model",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        const b = (body ?? {}) as Record<string, unknown>;
        const invalid = validateModelBody(b);
        if (invalid) return jsonError(400, "INVALID", invalid);
        const m = b as {
          public_id: string;
          slug: string;
          display_name: string;
          provider: string;
          description?: string;
          capabilities?: string[];
          context_window?: number | null;
        };
        const dup = await rawRows(db, sql`SELECT 1 FROM models WHERE public_id = ${m.public_id}`);
        if (dup.length) return jsonError(400, "DUPLICATE", "public_id already exists");
        const id = crypto.randomUUID();
        const now = Date.now();
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`INSERT INTO models (id, public_id, slug, display_name, provider, description, capabilities, context_window, enabled, published, prompt_caching, created_at, updated_at) VALUES (${id}, ${m.public_id}, ${m.slug}, ${m.display_name}, ${m.provider}, ${m.description ?? null}, ${m.capabilities === undefined || m.capabilities === null ? null : JSON.stringify(m.capabilities)}, ${m.context_window ?? null}, ${b.enabled === false ? false : true}, ${b.published === true ? true : false}, ${(b.prompt_caching as string | undefined) ?? "inherit"}, ${now}, ${now})`,
          );
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: null,
            action: "catalog.model.create",
            target: id,
            detail: { public_id: m.public_id, slug: m.slug, provider: m.provider },
          });
        });
        return new Response(JSON.stringify({ id, public_id: b.public_id }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    )
    .get(
      "/api/v1/admin/catalog/models",
      {
        detail: {
          tags: ["Catalog"],
          summary: "List catalog models",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        // Listing status mirrors listPublicModels (enabled + published + enabled
        // mapping + current price); hidden_reason names the first blocker.
        const now = Date.now();
        const rows = await rawRows<
          Record<string, unknown> & {
            id: string;
            enabled: boolean;
            published: boolean;
            has_price: boolean;
            has_mapping: boolean;
          }
        >(db, sql`
          SELECT m.*,
            EXISTS(SELECT 1 FROM model_prices p WHERE p.model_id = m.id AND p.retired_at IS NULL AND p.effective_at <= ${now}) AS has_price,
            EXISTS(SELECT 1 FROM provider_model_mappings pm WHERE pm.model_id = m.id AND pm.enabled = true) AS has_mapping
          FROM models m ORDER BY m.public_id`);
        return await Promise.all(
          rows.map(async (rawRow) => {
            const m = coerceNums(rawRow);
            const mapping =
              coerceNums(
                (
                  await rawRows<Record<string, unknown>>(
                    db,
                    sql`SELECT id, provider, upstream_model, enabled, created_at FROM provider_model_mappings WHERE model_id = ${m.id} AND enabled = true ORDER BY created_at ASC LIMIT 1`,
                  )
                )[0] ?? null,
              ) ?? null;
            const currentPrice =
              coerceNums(
                (
                  await rawRows<Record<string, unknown>>(
                    db,
                    sql`SELECT input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at FROM model_prices WHERE model_id = ${m.id} AND effective_at <= ${now} AND retired_at IS NULL ORDER BY effective_at DESC, id DESC LIMIT 1`,
                  )
                )[0] ?? null,
              ) ?? null;
            const hidden_reason = !m.enabled
              ? "disabled"
              : !m.published
                ? "not_published"
                : !m.has_mapping
                  ? "missing_mapping"
                  : !m.has_price
                    ? "missing_price"
                    : null;
            return {
              ...m,
              listed: hidden_reason === null,
              hidden_reason,
              mapping,
              current_price: currentPrice,
            };
          }),
        );
      },
    )
    .put(
      "/api/v1/admin/catalog/models/:id",
      {
        params: t.Object({ id: t.String() }),
        body: t.Optional(t.Record(t.String(), t.Any())),
        detail: {
          tags: ["Catalog"],
          summary: "Update catalog model",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        const existingRows = await rawRows<Record<string, unknown>>(
          db,
          sql`SELECT * FROM models WHERE id = ${params.id}`,
        );
        const existing = existingRows[0];
        if (!existing) return jsonError(404, "NOT_FOUND", "Model not found");
        const b = (body ?? {}) as Record<string, unknown>;
        // public_id is the stable public identifier and never mutable (P2).
        if (b.public_id !== undefined && b.public_id !== existing.public_id) {
          return jsonError(400, "INVALID", "public_id is immutable");
        }
        const merged = {
          public_id: b.public_id ?? existing.public_id,
          slug: b.slug ?? (existing.slug as string),
          display_name: b.display_name ?? (existing.display_name as string),
          provider: b.provider ?? (existing.provider as string),
          capabilities: b.capabilities ?? parseCaps(existing.capabilities),
          context_window: b.context_window ?? existing.context_window,
          prompt_caching: b.prompt_caching ?? existing.prompt_caching,
        };
        const invalid = validateModelBody(merged as Record<string, unknown>);
        if (invalid) return jsonError(400, "INVALID", invalid);
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE models SET slug = ${merged.slug as string}, display_name = ${merged.display_name as string}, provider = ${merged.provider as string}, description = ${b.description !== undefined ? (b.description as string | null) : (existing.description as string | null)}, capabilities = ${b.capabilities !== undefined ? (b.capabilities === null ? null : JSON.stringify(b.capabilities)) : (existing.capabilities == null ? null : JSON.stringify(existing.capabilities))}, context_window = ${b.context_window !== undefined ? ((b.context_window as number | null) ?? null) : ((existing.context_window as number | null) ?? null)}, enabled = ${b.enabled !== undefined ? !!b.enabled : !!existing.enabled}, published = ${b.published !== undefined ? !!b.published : !!existing.published}, prompt_caching = ${(b.prompt_caching as string | undefined) ?? (existing.prompt_caching as string)}, updated_at = ${Date.now()} WHERE id = ${params.id}`,
          );
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: null,
            action: "catalog.model.update",
            target: params.id,
            detail: b as Record<string, unknown>,
          });
        });
        return new Response(JSON.stringify({ id: params.id }), {
          headers: { "content-type": "application/json" },
        });
      },
    )
    .post(
      "/api/v1/admin/catalog/models/:id/mappings",
      {
        params: t.Object({ id: t.String() }),
        body: t.Optional(t.Record(t.String(), t.Any())),
        detail: {
          tags: ["Catalog"],
          summary: "Create provider mapping",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        if (!(await modelExists(db, params.id))) return jsonError(404, "NOT_FOUND", "Model not found");
        const b = (body ?? {}) as Record<string, unknown>;
        if (
          typeof b.upstream_model !== "string" ||
          !b.upstream_model.trim() ||
          (b.provider !== undefined && (typeof b.provider !== "string" || !b.provider.trim()))
        )
          return jsonError(400, "INVALID", "upstream_model is required");
        const provider = typeof b.provider === "string" && b.provider.trim() ? b.provider : "cpa";
        if (b.enabled === false) {
          const id = crypto.randomUUID();
          const now = Date.now();
          await db.transaction(async (tx) => {
            await tx.execute(
              sql`INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES (${id}, ${params.id}, ${provider}, ${b.upstream_model as string}, false, ${now}, ${now})`,
            );
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: null,
              action: "catalog.mapping.create",
              target: params.id,
              detail: { mapping_id: id, provider, upstream_model: b.upstream_model },
            });
          });
          return new Response(JSON.stringify({ id, model_id: params.id }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        // Enabled insert = setting the model's single route (never leaves two enabled).
        const { mappingId } = await setModelRoute(db, params.id, b.upstream_model as string, provider, userId);
        return new Response(JSON.stringify({ id: mappingId, model_id: params.id }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    )
    .put(
      "/api/v1/admin/catalog/models/:id/route",
      {
        params: t.Object({ id: t.String() }),
        body: t.Optional(t.Record(t.String(), t.Any())),
        detail: {
          tags: ["Catalog"],
          summary: "Set the model's single route",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        if (!(await modelExists(db, params.id))) return jsonError(404, "NOT_FOUND", "Model not found");
        const b = (body ?? {}) as Record<string, unknown>;
        if (
          typeof b.upstream_model !== "string" ||
          !b.upstream_model.trim() ||
          (b.provider !== undefined && (typeof b.provider !== "string" || !b.provider.trim()))
        )
          return jsonError(400, "INVALID", "upstream_model is required");
        const provider = typeof b.provider === "string" && b.provider.trim() ? b.provider : "cpa";
        const result = await setModelRoute(db, params.id, b.upstream_model.trim(), provider, userId);
        return { id: result.mappingId, model_id: params.id, changed: result.changed };
      },
    )
    .get(
      "/api/v1/admin/catalog/models/:id/prices",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Catalog"],
          summary: "List price history for a model",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        if (!(await modelExists(db, params.id))) return jsonError(404, "NOT_FOUND", "Model not found");
        const rows = await rawRows<{ id: string; effective_at: number } & Record<string, unknown>>(
          db,
          sql`SELECT * FROM model_prices WHERE model_id = ${params.id} ORDER BY effective_at DESC, id DESC`,
        );
        const current = await getCurrentPrice(db, params.id);
        return rows.map((r) => ({
          ...coerceNums(r),
          current: current !== null && r.id === current.id,
        }));
      },
    )
    .get(
      "/api/v1/admin/catalog/models/:id/mappings",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Catalog"],
          summary: "List provider mappings for a model",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        if (!(await modelExists(db, params.id))) return jsonError(404, "NOT_FOUND", "Model not found");
        return (await rawRows(
          db,
          sql`SELECT id, provider, upstream_model, enabled, created_at FROM provider_model_mappings WHERE model_id = ${params.id} ORDER BY created_at DESC, id DESC`,
        )).map((r) => coerceNums(r));
      },
    )
    .patch(
      "/api/v1/admin/catalog/mappings/:id",
      {
        params: t.Object({ id: t.String() }),
        body: t.Optional(t.Record(t.String(), t.Any())),
        detail: {
          tags: ["Catalog"],
          summary: "Enable or disable a provider mapping",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        const existingRows = await rawRows<Record<string, unknown>>(
          db,
          sql`SELECT * FROM provider_model_mappings WHERE id = ${params.id}`,
        );
        if (!existingRows[0]) return jsonError(404, "NOT_FOUND", "Mapping not found");
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b.enabled !== "boolean")
          return jsonError(400, "INVALID", "enabled (boolean) is required");
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE provider_model_mappings SET enabled = ${b.enabled}, updated_at = ${Date.now()} WHERE id = ${params.id}`,
          );
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: null,
            action: "catalog.mapping.update",
            target: params.id,
            detail: { enabled: b.enabled },
          });
        });
        return { id: params.id, enabled: b.enabled };
      },
    )
    .post(
      "/api/v1/admin/catalog/models/:id/prices",
      {
        params: t.Object({ id: t.String() }),
        body: t.Optional(t.Record(t.String(), t.Any())),
        detail: {
          tags: ["Catalog"],
          summary: "Create model price",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        if (!(await modelExists(db, params.id))) return jsonError(404, "NOT_FOUND", "Model not found");
        const b = (body ?? {}) as Record<string, unknown>;
        // Validate all money fields BEFORE touching the DB — model_prices rows are
        // never updated, only appended, so no bad row can sneak in later.
        for (const f of PRICE_FIELDS) {
          if (!isMoney(b[f]))
            return jsonError(
              400,
              "INVALID",
              `${f} must be an integer 0..${MAX_SAFE_INTEGER_MONEY}`,
            );
        }
        const id = crypto.randomUUID();
        const now = Date.now();
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES (${id}, ${params.id}, ${b.input_usd_micro_per_1m as number}, ${b.output_usd_micro_per_1m as number}, ${b.cached_input_usd_micro_per_1m as number}, ${b.reasoning_usd_micro_per_1m as number}, ${b.markup_ppm as number}, ${now}, NULL)`,
          );
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: null,
            action: "catalog.price.create",
            target: params.id,
            detail: { price_id: id, effective_at: now },
          });
        });
        return new Response(JSON.stringify({ id, model_id: params.id, effective_at: now }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    )
    .get(
      "/api/v1/admin/catalog/public",
      {
        detail: {
          tags: ["Catalog"],
          summary: "List public catalog models",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        return listPublicModels(db);
      },
    );
