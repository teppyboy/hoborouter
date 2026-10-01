// Canonical catalog admin API — instance-admin only (same authz as
// admin-models.ts). Every mutation writes an audit row atomically in the same
// transaction. model_prices rows are immutable: a price change inserts a NEW
// row with effective_at = server time; old rows are never updated.
import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit, jsonError } from "../authz";
import { MAX_SAFE_INTEGER_MONEY } from "@hoborouter/db";
import { listPublicModels } from "@hoborouter/catalog";

// `provider/name`, lowercase slug chars ([a-z0-9-]) on both sides.
const PUBLIC_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

/** capabilities is stored as a JSON string; raw bun:sqlite reads return it unparsed. */
function parseCaps(v: unknown): string[] | null {
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) && parsed.every((c) => typeof c === "string")
        ? (parsed as string[])
        : null;
    } catch {
      return null;
    }
  }
  return Array.isArray(v) ? (v as string[]) : null;
}

/** Non-negative safe integer within the canonical money bound. */
function isMoney(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_SAFE_INTEGER_MONEY;
}

function validateModelBody(b: Record<string, unknown>): string | null {
  if (typeof b.public_id !== "string" || !PUBLIC_ID_RE.test(b.public_id))
    return "public_id must be '<provider>/<name>' of lowercase slug chars";
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
  return null;
}

export const adminCatalogRoutes = (db: Database, auth: BetterAuthInstance) =>
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
        const denied = requireInstanceAdmin(db, userId);
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
        if (db.prepare("SELECT 1 FROM models WHERE public_id = ?").get(m.public_id))
          return jsonError(400, "DUPLICATE", "public_id already exists");
        const id = crypto.randomUUID();
        const now = Date.now();
        db.transaction(() => {
          db.prepare(
            "INSERT INTO models (id, public_id, slug, display_name, provider, description, capabilities, context_window, enabled, published, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          ).run(
            id,
            m.public_id,
            m.slug,
            m.display_name,
            m.provider,
            m.description ?? null,
            m.capabilities === undefined ? null : JSON.stringify(m.capabilities),
            m.context_window ?? null,
            b.enabled === false ? 0 : 1,
            b.published === true ? 1 : 0,
            now,
            now,
          );
          writeAudit(db, {
            actorUserId: userId,
            workspaceId: null,
            action: "catalog.model.create",
            target: id,
            detail: { public_id: m.public_id, slug: m.slug, provider: m.provider },
          });
        })();
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
        const denied = requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        return db.prepare("SELECT * FROM models ORDER BY public_id").all();
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
        const denied = requireInstanceAdmin(db, userId);
        if (denied) return denied;
        const existing = db.prepare("SELECT * FROM models WHERE id = ?").get(params.id) as
          | Record<string, unknown>
          | undefined;
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
        };
        const invalid = validateModelBody(merged as Record<string, unknown>);
        if (invalid) return jsonError(400, "INVALID", invalid);
        db.transaction(() => {
          db.prepare(
            "UPDATE models SET slug = ?, display_name = ?, provider = ?, description = ?, capabilities = ?, context_window = ?, enabled = ?, published = ?, updated_at = ? WHERE id = ?",
          ).run(
            merged.slug as string,
            merged.display_name as string,
            merged.provider as string,
            b.description !== undefined
              ? (b.description as string | null)
              : (existing.description as string | null),
            b.capabilities !== undefined
              ? JSON.stringify(b.capabilities)
              : (existing.capabilities as string | null),
            b.context_window !== undefined
              ? (b.context_window as number | null)
              : (existing.context_window as number | null),
            b.enabled !== undefined ? (b.enabled ? 1 : 0) : (existing.enabled as number),
            b.published !== undefined ? (b.published ? 1 : 0) : (existing.published as number),
            Date.now(),
            params.id,
          );
          writeAudit(db, {
            actorUserId: userId,
            workspaceId: null,
            action: "catalog.model.update",
            target: params.id,
            detail: b as Record<string, unknown>,
          });
        })();
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
        const denied = requireInstanceAdmin(db, userId);
        if (denied) return denied;
        if (!db.prepare("SELECT 1 FROM models WHERE id = ?").get(params.id))
          return jsonError(404, "NOT_FOUND", "Model not found");
        const b = (body ?? {}) as Record<string, unknown>;
        if (
          typeof b.provider !== "string" ||
          !b.provider.trim() ||
          typeof b.upstream_model !== "string" ||
          !b.upstream_model.trim()
        )
          return jsonError(400, "INVALID", "provider and upstream_model are required");
        const id = crypto.randomUUID();
        const now = Date.now();
        db.transaction(() => {
          db.prepare(
            "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
          ).run(
            id,
            params.id,
            b.provider as string,
            b.upstream_model as string,
            b.enabled === false ? 0 : 1,
            now,
            now,
          );
          writeAudit(db, {
            actorUserId: userId,
            workspaceId: null,
            action: "catalog.mapping.create",
            target: params.id,
            detail: { mapping_id: id, provider: b.provider, upstream_model: b.upstream_model },
          });
        })();
        return new Response(JSON.stringify({ id, model_id: params.id }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
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
        const denied = requireInstanceAdmin(db, userId);
        if (denied) return denied;
        if (!db.prepare("SELECT 1 FROM models WHERE id = ?").get(params.id))
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
        db.transaction(() => {
          db.prepare(
            "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES (?,?,?,?,?,?,?,?,NULL)",
          ).run(
            id,
            params.id,
            b.input_usd_micro_per_1m as number,
            b.output_usd_micro_per_1m as number,
            b.cached_input_usd_micro_per_1m as number,
            b.reasoning_usd_micro_per_1m as number,
            b.markup_ppm as number,
            now,
          );
          writeAudit(db, {
            actorUserId: userId,
            workspaceId: null,
            action: "catalog.price.create",
            target: params.id,
            detail: { price_id: id, effective_at: now },
          });
        })();
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
        const denied = requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        return listPublicModels(db);
      },
    );
