// Canonical catalog admin API — instance-admin only (same authz as
// admin-models.ts). Every mutation writes an audit row atomically in the same
// transaction. model_prices rows are immutable: a price change inserts a NEW
// row with effective_at = server time; old rows are never updated.
import { Elysia, t } from "elysia";
import type { Db, Tx } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit, jsonError } from "../authz";
import { MAX_SAFE_INTEGER_MONEY, isUniqueViolation, REASONING_EFFORTS } from "@hoborouter/db";
import { sql, type SQL } from "drizzle-orm";
import { getCurrentPrice, listPublicModels } from "@hoborouter/catalog";

function isReasoningEffort(v: unknown): v is (typeof REASONING_EFFORTS)[number] {
  return typeof v === "string" && (REASONING_EFFORTS as readonly string[]).includes(v);
}

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
  if (Array.isArray(value))
    // SAFETY: recursion preserves the element/array shape; only numeric string
    // fields are converted to numbers.
    return value.map((v) => coerceNums(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = NUMERIC_FIELDS.has(k) && typeof v === "string" ? Number(v) : coerceNums(v);
    // SAFETY: out is a fieldwise copy of the original object value.
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
  // Whitelist validation only: auto_eligible toggles auto-routing candidacy,
  // nothing else. Also accepted on its own via the update route.
  if (b.auto_eligible !== undefined && typeof b.auto_eligible !== "boolean")
    return "auto_eligible must be a boolean";
  if (
    b.default_reasoning_effort !== undefined &&
    b.default_reasoning_effort !== null &&
    !isReasoningEffort(b.default_reasoning_effort)
  )
    return "default_reasoning_effort must be a reasoning effort or null";
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
        if (dup.length) return jsonError(409, "DUPLICATE", "public_id already exists");
        const id = crypto.randomUUID();
        const now = Date.now();
        try {
          await db.transaction(async (tx) => {
            await tx.execute(
              sql`INSERT INTO models (id, public_id, slug, display_name, provider, description, capabilities, context_window, enabled, published, auto_eligible, prompt_caching, default_reasoning_effort, created_at, updated_at) VALUES (${id}, ${m.public_id}, ${m.slug}, ${m.display_name}, ${m.provider}, ${m.description ?? null}, ${m.capabilities === undefined || m.capabilities === null ? null : JSON.stringify(m.capabilities)}, ${m.context_window ?? null}, ${b.enabled === false ? false : true}, ${b.published === true ? true : false}, ${b.auto_eligible === true}, ${(b.prompt_caching as string | undefined) ?? "inherit"}, ${(b.default_reasoning_effort as string | undefined | null) ?? null}, ${now}, ${now})`,
            );
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: null,
              action: "catalog.model.create",
              target: id,
              detail: {
                public_id: m.public_id,
                slug: m.slug,
                provider: m.provider,
                auto_eligible: b.auto_eligible === true,
              },
            });
          });
        } catch (e) {
          // Concurrent create with the same public_id passes the pre-check; the
          // unique index on models.public_id rejects the loser mid-transaction.
          if (isUniqueViolation(e)) return jsonError(409, "DUPLICATE", "public_id already exists");
          throw e;
        }
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
        >(
          db,
          sql`
          SELECT m.*,
            EXISTS(SELECT 1 FROM model_prices p WHERE p.model_id = m.id AND p.retired_at IS NULL AND p.effective_at <= ${now}) AS has_price,
            EXISTS(SELECT 1 FROM provider_model_mappings pm WHERE pm.model_id = m.id AND pm.enabled = true) AS has_mapping
          FROM models m ORDER BY m.public_id`,
        );
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
        // public_id is renameable; old names stay only in history snapshots
        // (usage_logs.public_model), never as an alias — old name 404s.
        let renamedPublicId: string | null = null;
        if (b.public_id !== undefined) {
          if (typeof b.public_id !== "string")
            return jsonError(
              400,
              "INVALID",
              "public_id must be a lowercase slug or '<provider>/<name>'",
            );
          const trimmed = b.public_id.trim();
          if (trimmed !== existing.public_id) {
            if (!PUBLIC_ID_RE.test(trimmed))
              return jsonError(
                400,
                "INVALID",
                "public_id must be a lowercase slug or '<provider>/<name>'",
              );
            const dup = await rawRows(
              db,
              sql`SELECT 1 FROM models WHERE public_id = ${trimmed} AND id <> ${params.id}`,
            );
            if (dup.length) return jsonError(409, "DUPLICATE", "public_id already exists");
            renamedPublicId = trimmed;
          }
        }
        const merged = {
          public_id: renamedPublicId ?? (existing.public_id as string),
          slug: renamedPublicId
            ? (renamedPublicId.split("/").pop() as string)
            : (b.slug ?? (existing.slug as string)),
          display_name: b.display_name ?? (existing.display_name as string),
          provider: b.provider ?? (existing.provider as string),
          capabilities: b.capabilities ?? parseCaps(existing.capabilities),
          context_window: b.context_window ?? existing.context_window,
          prompt_caching: b.prompt_caching ?? existing.prompt_caching,
          default_reasoning_effort:
            b.default_reasoning_effort !== undefined
              ? b.default_reasoning_effort
              : existing.default_reasoning_effort,
        };
        const invalid = validateModelBody(merged as Record<string, unknown>);
        if (invalid) return jsonError(400, "INVALID", invalid);
        if (b.auto_eligible !== undefined && typeof b.auto_eligible !== "boolean")
          return jsonError(400, "INVALID", "auto_eligible must be a boolean");
        // Absent auto_eligible keeps the current value.
        const autoEligible =
          b.auto_eligible !== undefined ? !!b.auto_eligible : !!existing.auto_eligible;
        try {
          await db.transaction(async (tx) => {
            await tx.execute(
              sql`UPDATE models SET public_id = ${merged.public_id}, slug = ${merged.slug as string}, display_name = ${merged.display_name as string}, provider = ${merged.provider as string}, description = ${b.description !== undefined ? (b.description as string | null) : (existing.description as string | null)}, capabilities = ${b.capabilities !== undefined ? (b.capabilities === null ? null : JSON.stringify(b.capabilities)) : existing.capabilities == null ? null : JSON.stringify(existing.capabilities)}, context_window = ${b.context_window !== undefined ? ((b.context_window as number | null) ?? null) : ((existing.context_window as number | null) ?? null)}, enabled = ${b.enabled !== undefined ? !!b.enabled : !!existing.enabled}, published = ${b.published !== undefined ? !!b.published : !!existing.published}, auto_eligible = ${autoEligible}, prompt_caching = ${(b.prompt_caching as string | undefined) ?? (existing.prompt_caching as string)}, default_reasoning_effort = ${(merged.default_reasoning_effort as string | null | undefined) ?? null}, updated_at = ${Date.now()} WHERE id = ${params.id}`,
            );
            if (renamedPublicId)
              await writeAudit(tx, {
                actorUserId: userId,
                workspaceId: null,
                action: "catalog.model.rename",
                target: params.id,
                detail: { from: existing.public_id, to: renamedPublicId },
              });
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: null,
              action: "catalog.model.update",
              target: params.id,
              detail: b as Record<string, unknown>,
            });
          });
        } catch (e) {
          // Concurrent rename to the same public_id passes the pre-check; the
          // unique index on models.public_id rejects the loser mid-transaction.
          if (isUniqueViolation(e)) return jsonError(409, "DUPLICATE", "public_id already exists");
          throw e;
        }
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
        if (!(await modelExists(db, params.id)))
          return jsonError(404, "NOT_FOUND", "Model not found");
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
        const { mappingId } = await setModelRoute(
          db,
          params.id,
          b.upstream_model as string,
          provider,
          userId,
        );
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
        if (!(await modelExists(db, params.id)))
          return jsonError(404, "NOT_FOUND", "Model not found");
        const b = (body ?? {}) as Record<string, unknown>;
        if (
          typeof b.upstream_model !== "string" ||
          !b.upstream_model.trim() ||
          (b.provider !== undefined && (typeof b.provider !== "string" || !b.provider.trim()))
        )
          return jsonError(400, "INVALID", "upstream_model is required");
        const provider = typeof b.provider === "string" && b.provider.trim() ? b.provider : "cpa";
        const result = await setModelRoute(
          db,
          params.id,
          b.upstream_model.trim(),
          provider,
          userId,
        );
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
        if (!(await modelExists(db, params.id)))
          return jsonError(404, "NOT_FOUND", "Model not found");
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
        if (!(await modelExists(db, params.id)))
          return jsonError(404, "NOT_FOUND", "Model not found");
        return (
          await rawRows(
            db,
            sql`SELECT id, provider, upstream_model, enabled, created_at FROM provider_model_mappings WHERE model_id = ${params.id} ORDER BY created_at DESC, id DESC`,
          )
        ).map((r) => coerceNums(r));
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
      "/api/v1/admin/catalog/models/:id/reasoning-routes",
      {
        params: t.Object({ id: t.String() }),
        body: t.Optional(t.Record(t.String(), t.Any())),
        detail: {
          tags: ["Catalog"],
          summary: "Create or replace a reasoning route for a model",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        if (!(await modelExists(db, params.id)))
          return jsonError(404, "NOT_FOUND", "Model not found");
        const b = (body ?? {}) as Record<string, unknown>;
        if (!isReasoningEffort(b.public_effort))
          return jsonError(400, "INVALID", "public_effort must be a reasoning effort");
        if (
          b.upstream_effort !== undefined &&
          b.upstream_effort !== null &&
          !isReasoningEffort(b.upstream_effort)
        )
          return jsonError(400, "INVALID", "upstream_effort must be a reasoning effort or null");
        if (typeof b.upstream_model !== "string" || !b.upstream_model.trim())
          return jsonError(400, "INVALID", "upstream_model is required");
        if (b.provider !== undefined && (typeof b.provider !== "string" || !b.provider.trim()))
          return jsonError(400, "INVALID", "provider must be a non-empty string");
        const provider = typeof b.provider === "string" && b.provider.trim() ? b.provider : "cpa";
        const upstreamEffort = isReasoningEffort(b.upstream_effort)
          ? b.upstream_effort
          : b.public_effort;
        const publicEffort = b.public_effort as (typeof REASONING_EFFORTS)[number];
        const now = Date.now();
        // Re-authoring an effort disables the previous enabled row (history
        // preserved, same pattern as setModelRoute); the partial unique index
        // on (model_id, public_effort) WHERE enabled arbiters concurrency.
        const beforeRows = await rawRows<{
          id: string;
          upstream_model: string;
          upstream_effort: string;
          provider: string;
        }>(
          db,
          sql`SELECT id, upstream_model, upstream_effort, provider FROM model_reasoning_routes WHERE model_id = ${params.id} AND public_effort = ${publicEffort} AND enabled = true LIMIT 1`,
        );
        const before = beforeRows[0] ?? null;
        if (
          before &&
          before.upstream_model === b.upstream_model &&
          before.upstream_effort === upstreamEffort &&
          before.provider === provider
        )
          return {
            id: before.id,
            model_id: params.id,
            public_effort: publicEffort,
            changed: false,
          };
        const id = crypto.randomUUID();
        try {
          await db.transaction(async (tx) => {
            if (before)
              await tx.execute(
                sql`UPDATE model_reasoning_routes SET enabled = false, updated_at = ${now} WHERE id = ${before.id}`,
              );
            await tx.execute(
              sql`INSERT INTO model_reasoning_routes (id, model_id, public_effort, provider, upstream_model, upstream_effort, enabled, sort_order, created_at, updated_at) VALUES (${id}, ${params.id}, ${publicEffort}, ${provider}, ${b.upstream_model as string}, ${upstreamEffort}, true, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM model_reasoning_routes WHERE model_id = ${params.id} AND enabled = true), ${now}, ${now})`,
            );
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: null,
              action: "catalog.reasoning_route.update",
              target: params.id,
              detail: {
                public_effort: publicEffort,
                before: before
                  ? {
                      id: before.id,
                      provider: before.provider,
                      upstream_model: before.upstream_model,
                      upstream_effort: before.upstream_effort,
                    }
                  : null,
                after: {
                  id,
                  provider,
                  upstream_model: b.upstream_model,
                  upstream_effort: upstreamEffort,
                },
              },
            });
          });
        } catch (e) {
          // Concurrent re-authors of the same effort: the loser hits the
          // partial unique index mid-transaction and rolls back whole.
          if (isUniqueViolation(e))
            return jsonError(
              409,
              "DUPLICATE",
              "A concurrent update changed this effort's route; retry",
            );
          throw e;
        }
        return new Response(
          JSON.stringify({
            id,
            model_id: params.id,
            public_effort: publicEffort,
            upstream_effort: upstreamEffort,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      },
    )
    .get(
      "/api/v1/admin/catalog/models/:id/reasoning-routes",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Catalog"],
          summary: "List reasoning routes for a model",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        if (!(await modelExists(db, params.id)))
          return jsonError(404, "NOT_FOUND", "Model not found");
        return (
          await rawRows(
            db,
            sql`SELECT id, public_effort, provider, upstream_model, upstream_effort, enabled, sort_order, created_at, updated_at FROM model_reasoning_routes WHERE model_id = ${params.id} ORDER BY created_at DESC, id DESC`,
          )
        ).map((r) => coerceNums(r));
      },
    )
    .delete(
      "/api/v1/admin/catalog/reasoning-routes/:routeId",
      {
        params: t.Object({ routeId: t.String() }),
        detail: {
          tags: ["Catalog"],
          summary: "Soft-disable (delete) a reasoning route",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        const existingRows = await rawRows<{
          id: string;
          model_id: string;
          public_effort: string;
          provider: string;
          upstream_model: string;
          upstream_effort: string;
          enabled: boolean;
        }>(
          db,
          sql`SELECT id, model_id, public_effort, provider, upstream_model, upstream_effort, enabled FROM model_reasoning_routes WHERE id = ${params.routeId}`,
        );
        const route = existingRows[0];
        if (!route) return jsonError(404, "NOT_FOUND", "Reasoning route not found");
        if (!route.enabled)
          return { id: route.id, model_id: route.model_id, enabled: false, changed: false };
        // Guards: a model must keep at least one enabled route, and the route
        // backing its default effort cannot be removed (the gateway would
        // reject every default-effort request). Both checks race with the
        // update inside one transaction.
        const guards = await rawRows<{
          enabled_count: number;
          default_effort: string | null;
        }>(
          db,
          sql`SELECT (SELECT COUNT(*) FROM model_reasoning_routes WHERE model_id = ${route.model_id} AND enabled = true) AS enabled_count, (SELECT default_reasoning_effort FROM models WHERE id = ${route.model_id}) AS default_effort`,
        );
        const g = guards[0];
        if (g && Number(g.enabled_count) <= 1)
          return jsonError(
            409,
            "LAST_ENABLED_ROUTE",
            "Cannot remove the last enabled reasoning route for a model",
          );
        if (g && g.default_effort !== null && g.default_effort === route.public_effort)
          return jsonError(
            409,
            "DEFAULT_ROUTE",
            "This route backs the model's default reasoning effort; change default_reasoning_effort first",
          );
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE model_reasoning_routes SET enabled = false, updated_at = ${Date.now()} WHERE id = ${route.id}`,
          );
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: null,
            action: "catalog.reasoning_route.delete",
            target: route.id,
            detail: {
              model_id: route.model_id,
              public_effort: route.public_effort,
              provider: route.provider,
              upstream_model: route.upstream_model,
              upstream_effort: route.upstream_effort,
            },
          });
        });
        return { id: route.id, model_id: route.model_id, enabled: false, changed: true };
      },
    )
    .post(
      "/api/v1/admin/catalog/models/:id/reasoning-routes/reorder",
      {
        params: t.Object({ id: t.String() }),
        body: t.Optional(t.Record(t.String(), t.Any())),
        detail: {
          tags: ["Catalog"],
          summary: "Reorder a model's enabled reasoning routes",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        if (!(await modelExists(db, params.id)))
          return jsonError(404, "NOT_FOUND", "Model not found");
        const b = (body ?? {}) as Record<string, unknown>;
        const ids = b.route_ids;
        if (
          !Array.isArray(ids) ||
          ids.some((x) => typeof x !== "string") ||
          new Set(ids).size !== ids.length
        )
          return jsonError(
            400,
            "INVALID",
            "route_ids must be an ordered array of unique route IDs",
          );
        try {
          const result = await db.transaction(async (tx) => {
            // Lock the model's enabled routes: the strict set check and the
            // rewrites below race against concurrent create/delete/reorder.
            const enabled = await rawRows<{ id: string }>(
              tx,
              sql`SELECT id FROM model_reasoning_routes WHERE model_id = ${params.id} AND enabled = true ORDER BY sort_order, created_at, id FOR UPDATE`,
            );
            const enabledIds = enabled.map((r) => r.id);
            const ordered = ids as string[];
            const sameSet =
              ordered.length === enabledIds.length &&
              [...ordered].sort().join("\n") === [...enabledIds].sort().join("\n");
            if (!sameSet) return null;
            for (const [i, rid] of ordered.entries())
              await tx.execute(
                sql`UPDATE model_reasoning_routes SET sort_order = ${i} WHERE id = ${rid}`,
              );
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: null,
              action: "catalog.reasoning_route.reorder",
              target: params.id,
              detail: { route_ids: ordered },
            });
            return { route_ids: ordered };
          });
          if (!result)
            return jsonError(
              400,
              "INVALID",
              "route_ids must be exactly the model's enabled reasoning routes",
            );
          return result;
        } catch (e) {
          if (isUniqueViolation(e))
            return jsonError(409, "DUPLICATE", "A concurrent update changed these routes; retry");
          throw e;
        }
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
        if (!(await modelExists(db, params.id)))
          return jsonError(404, "NOT_FOUND", "Model not found");
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
