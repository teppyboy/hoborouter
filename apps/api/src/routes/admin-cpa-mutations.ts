// Admin CPA management mutations — instance-admin only.
//
// Targets the pinned CLIProxyAPI v8.0.4 legacy management plane
// (/v0/management, routes verified against the tag's
// internal/api/server_management.go). Every upstream path/method is an
// explicit allowlist entry below — this module is NEVER a generic proxy.
//
// Security invariants:
// - No upstream response body is ever proxied to the client (bodies can carry
//   key material and credential metadata); success returns {ok: true} only.
// - Secret values are accepted only in dedicated request fields (api key
//   value, config YAML) and are never written to the audit log.
// - Upstream error statuses are preserved, but only CPA's own `error`/`message`
//   string is surfaced, truncated — arbitrary body bytes never pass through.
// - Dangerous operations (config replace, client-key delete, auth-file delete,
//   proxy-url change) require an explicit confirm: true.
// - No reload/restart endpoints exist on v8.0.4 /v0/management (verified);
//   none are exposed.
import { Elysia, t } from "elysia";
import type { Db } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit, jsonError } from "../authz";

const cpaBase = () => process.env.CPA_BASE_URL || "http://cpa:8317";
const cpaMgmtKey = () => process.env.CPA_MANAGEMENT_KEY || "";

const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_CONFIG_YAML_BYTES = 262_144;

// CPA v0/management boolean config fields (server_management.go @ v8.0.4).
const BOOL_FLAGS = [
  "debug",
  "usage-statistics-enabled",
  "request-log",
  "ws-auth",
  "logging-to-file",
  "force-model-prefix",
  "quota-exceeded/switch-project",
  "quota-exceeded/switch-preview-model",
] as const;

const ROUTING_STRATEGIES = ["round-robin", "weighted-round-robin", "fill-first"] as const;

type CpaUpstream = { status: number; errorText: string | null };

/**
 * Single-attempt upstream call. Bearer auth is attached here and never logged.
 * The response is reduced to {status, errorText}; success bodies are drained
 * and discarded so no key material or credential metadata can leak out.
 */
async function cpaCall(
  method: "PUT" | "PATCH" | "POST" | "DELETE",
  upstreamPath: string,
  body?: string,
  contentType = "application/json",
): Promise<CpaUpstream> {
  const key = cpaMgmtKey();
  if (!key) return { status: 0, errorText: "CPA_MANAGEMENT_KEY is not set" };
  try {
    const res = await fetch(`${cpaBase()}${upstreamPath}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body !== undefined ? { "content-type": contentType } : {}),
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    let errorText: string | null = null;
    if (!res.ok) {
      // Reduce the upstream body to its own error/message string, truncated.
      // Never forward raw upstream bytes to the client.
      try {
        const parsed = (await res.json()) as { error?: unknown; message?: unknown };
        const msg =
          typeof parsed.error === "string"
            ? parsed.error
            : typeof parsed.message === "string"
              ? parsed.message
              : null;
        errorText = msg === null ? null : msg.slice(0, 300);
      } catch {
        errorText = null;
      }
    } else {
      // Drain (and discard) the success body so the socket is released.
      await res.arrayBuffer().catch(() => undefined);
    }
    return { status: res.status, errorText };
  } catch (err) {
    const detail =
      err instanceof Error && err.name === "TimeoutError" ? "timed out" : "did not respond";
    return { status: -1, errorText: `CPA at ${new URL(cpaBase()).host} ${detail}` };
  }
}

function cpaFailure(result: CpaUpstream): Response {
  if (result.status === 0)
    return jsonError(502, "CPA_UNCONFIGURED", result.errorText ?? "CPA unconfigured");
  if (result.status === -1)
    return jsonError(502, "CPA_UNREACHABLE", result.errorText ?? "CPA unreachable");
  if (result.status === 401 || result.status === 403)
    return jsonError(
      result.status,
      "CPA_AUTH_FAILED",
      `CPA rejected CPA_MANAGEMENT_KEY (${result.status})`,
    );
  return jsonError(
    result.status,
    "CPA_UPSTREAM_ERROR",
    result.errorText ?? `CPA management returned ${result.status}`,
  );
}

const isOk = (s: number) => s >= 200 && s < 300;

/** Audit helper: workspace is always null (instance scope); secrets never enter `detail`. */
async function audit(
  db: Db,
  actorUserId: string,
  action: string,
  target: string,
  detail: Record<string, unknown>,
) {
  await writeAudit(db, { actorUserId, workspaceId: null, action, target, detail });
}

type Gate = { userId: string } | Response;

/** Session + instance-admin gate shared by every route in this module. */
async function gateAdmin(db: Db, auth: BetterAuthInstance, request: Request): Promise<Gate> {
  // requireSession's inferred union carries optional-undefined counterparts,
  // so `"error" in gate` does not narrow under TS 6 — check session instead.
  const gate = await requireSession(auth, request);
  if (gate.session === undefined || gate.session === null)
    return gate.error ?? jsonError(401, "UNAUTHORIZED", "Authentication required");
  const denied = await requireInstanceAdmin(db, gate.session.user.id);
  if (denied) return denied;
  return { userId: gate.session.user.id };
}

const strict = { additionalProperties: false } as const;

export const adminCpaMutationRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-cpa-mutations" })
    // ── Config save: full YAML replace of CPA's config file ──────────────────
    .put(
      "/api/v1/admin/cpa/config",
      {
        body: t.Object(
          {
            config_yaml: t.String({ minLength: 1, maxLength: MAX_CONFIG_YAML_BYTES }),
            confirm: t.Literal(true),
          },
          strict,
        ),
        detail: {
          tags: ["System"],
          summary: "Replace CPA config.yaml (dangerous)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        const result = await cpaCall(
          "PUT",
          "/v0/management/config.yaml",
          body.config_yaml,
          "application/x-yaml",
        );
        await audit(db, g.userId, "cpa.config.save", "cpa:/v0/management/config.yaml", {
          upstream_status: result.status,
          bytes: body.config_yaml.length,
        });
        if (!isOk(result.status)) return cpaFailure(result);
        return { ok: true };
      },
    )
    // ── Boolean config flags ──────────────────────────────────────────────────
    .patch(
      "/api/v1/admin/cpa/config/flags",
      {
        body: t.Object(
          { flag: t.Union(BOOL_FLAGS.map((f) => t.Literal(f))), value: t.Boolean() },
          strict,
        ),
        detail: {
          tags: ["System"],
          summary: "Toggle a CPA boolean config field",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        const upstreamPath = `/v0/management/${body.flag}`;
        const result = await cpaCall("PUT", upstreamPath, JSON.stringify({ value: body.value }));
        await audit(db, g.userId, "cpa.config.flag", `cpa:${upstreamPath}`, {
          upstream_status: result.status,
          value: body.value,
        });
        if (!isOk(result.status)) return cpaFailure(result);
        return { ok: true };
      },
    )
    // ── Proxy URL: redirects all CPA upstream traffic; confirm required ──────
    .put(
      "/api/v1/admin/cpa/config/proxy-url",
      {
        body: t.Object(
          {
            value: t.String({
              minLength: 1,
              maxLength: 2048,
              pattern: "^(https?|socks5h?)://[^\\s]+$",
            }),
            confirm: t.Literal(true),
          },
          strict,
        ),
        detail: {
          tags: ["System"],
          summary: "Set CPA upstream proxy URL (dangerous)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        const result = await cpaCall(
          "PUT",
          "/v0/management/proxy-url",
          JSON.stringify({ value: body.value }),
        );
        await audit(db, g.userId, "cpa.config.proxy_url", "cpa:/v0/management/proxy-url", {
          upstream_status: result.status,
        });
        if (!isOk(result.status)) return cpaFailure(result);
        return { ok: true };
      },
    )
    .delete(
      "/api/v1/admin/cpa/config/proxy-url",
      {
        body: t.Object({ confirm: t.Literal(true) }, strict),
        detail: {
          tags: ["System"],
          summary: "Clear CPA upstream proxy URL (dangerous)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        const result = await cpaCall("DELETE", "/v0/management/proxy-url");
        await audit(db, g.userId, "cpa.config.proxy_url", "cpa:/v0/management/proxy-url", {
          upstream_status: result.status,
          removed: true,
        });
        if (!isOk(result.status)) return cpaFailure(result);
        return { ok: true };
      },
    )
    // ── Retry tuning: integer config fields ──────────────────────────────────
    .put(
      "/api/v1/admin/cpa/config/retry",
      {
        body: t.Object(
          {
            request_retry: t.Optional(t.Integer({ minimum: 0, maximum: 1000 })),
            max_retry_credentials: t.Optional(t.Integer({ minimum: 0, maximum: 1000 })),
            max_retry_interval: t.Optional(t.Integer({ minimum: 0, maximum: 1000 })),
          },
          strict,
        ),
        detail: {
          tags: ["System"],
          summary: "Update CPA retry tuning fields",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        const updates: [string, number][] = [];
        if (body.request_retry !== undefined)
          updates.push(["/v0/management/request-retry", body.request_retry]);
        if (body.max_retry_credentials !== undefined)
          updates.push(["/v0/management/max-retry-credentials", body.max_retry_credentials]);
        if (body.max_retry_interval !== undefined)
          updates.push(["/v0/management/max-retry-interval", body.max_retry_interval]);
        const results: CpaUpstream[] = [];
        for (const [path, value] of updates) {
          results.push(await cpaCall("PUT", path, JSON.stringify({ value })));
        }
        const failed = results.find((r) => !isOk(r.status));
        await audit(db, g.userId, "cpa.config.retry", "cpa:/v0/management", {
          upstream_status: failed ? failed.status : 200,
          fields: updates.map(([p]) => p),
        });
        if (failed) return cpaFailure(failed);
        return { ok: true };
      },
    )
    // ── Client access keys (CPA access.api-keys) ─────────────────────────────
    .patch(
      "/api/v1/admin/cpa/api-keys",
      {
        body: t.Object(
          {
            old: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
            new: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
            index: t.Optional(t.Integer({ minimum: 0 })),
            value: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
          },
          strict,
        ),
        detail: {
          tags: ["System"],
          summary: "Add or rotate a CPA client access key (secret never returned)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        // CPA PATCH /api-keys semantics (config_lists.go @ v8.0.4): {old,new}
        // replaces old with new, appending new when old is absent; {index,value}
        // replaces at index. Add = old==new==key (append when absent).
        const isAdd = body.new !== undefined && body.old === undefined;
        const upstreamBody = isAdd
          ? { old: body.new, new: body.new }
          : { old: body.old, new: body.new, index: body.index, value: body.value };
        const result = await cpaCall(
          "PATCH",
          "/v0/management/api-keys",
          JSON.stringify(upstreamBody),
        );
        await audit(
          db,
          g.userId,
          isAdd ? "cpa.api_key.add" : "cpa.api_key.update",
          "cpa:/v0/management/api-keys",
          {
            upstream_status: result.status,
            // Never the key value itself.
            old_index: body.index ?? null,
          },
        );
        if (!isOk(result.status)) return cpaFailure(result);
        return { ok: true };
      },
    )
    .delete(
      "/api/v1/admin/cpa/api-keys",
      {
        body: t.Object(
          { key: t.String({ minLength: 1, maxLength: 512 }), confirm: t.Literal(true) },
          strict,
        ),
        detail: {
          tags: ["System"],
          summary: "Delete a CPA client access key (dangerous)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        const result = await cpaCall(
          "DELETE",
          `/v0/management/api-keys?value=${encodeURIComponent(body.key)}`,
        );
        await audit(db, g.userId, "cpa.api_key.delete", "cpa:/v0/management/api-keys", {
          upstream_status: result.status,
          // Never the key value itself.
          key_chars: body.key.length,
        });
        if (!isOk(result.status)) return cpaFailure(result);
        return { ok: true };
      },
    )
    // ── Auth files (OAuth credentials): enable/disable ───────────────────────
    .patch(
      "/api/v1/admin/cpa/auth-files/status",
      {
        body: t.Object(
          {
            name: t.String({ minLength: 1, maxLength: 255 }),
            auth_index: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
            disabled: t.Boolean(),
          },
          strict,
        ),
        detail: {
          tags: ["System"],
          summary: "Enable or disable a CPA auth file (credential)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        const result = await cpaCall(
          "PATCH",
          "/v0/management/auth-files/status",
          JSON.stringify({ name: body.name, auth_index: body.auth_index, disabled: body.disabled }),
        );
        await audit(db, g.userId, "cpa.auth_file.status", "cpa:/v0/management/auth-files/status", {
          upstream_status: result.status,
          name: body.name,
          disabled: body.disabled,
        });
        if (!isOk(result.status)) return cpaFailure(result);
        return { ok: true };
      },
    )
    // ── Auth files: metadata field updates ───────────────────────────────────
    .patch(
      "/api/v1/admin/cpa/auth-files/fields",
      {
        body: t.Object(
          {
            name: t.String({ minLength: 1, maxLength: 255 }),
            fields: t.Record(t.String({ minLength: 1, maxLength: 128 }), t.Any(), {
              minProperties: 1,
              maxProperties: 32,
            }),
          },
          strict,
        ),
        detail: {
          tags: ["System"],
          summary: "Patch CPA auth-file metadata fields (CPA validates field names)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        const result = await cpaCall(
          "PATCH",
          "/v0/management/auth-files/fields",
          JSON.stringify({ name: body.name, ...body.fields }),
        );
        await audit(db, g.userId, "cpa.auth_file.fields", "cpa:/v0/management/auth-files/fields", {
          upstream_status: result.status,
          name: body.name,
          // Field names only; values may hold credential metadata.
          field_names: Object.keys(body.fields),
        });
        if (!isOk(result.status)) return cpaFailure(result);
        return { ok: true };
      },
    )
    // ── Auth files: delete (dangerous) ───────────────────────────────────────
    .delete(
      "/api/v1/admin/cpa/auth-files",
      {
        body: t.Object(
          {
            names: t.Array(t.String({ minLength: 1, maxLength: 255 }), {
              minItems: 1,
              maxItems: 50,
            }),
            confirm: t.Literal(true),
          },
          strict,
        ),
        detail: {
          tags: ["System"],
          summary: "Delete named CPA auth files (dangerous)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        // Named files only; CPA's destructive ?all=true variant is never sent.
        const result = await cpaCall(
          "DELETE",
          "/v0/management/auth-files",
          JSON.stringify({ names: body.names }),
        );
        await audit(db, g.userId, "cpa.auth_file.delete", "cpa:/v0/management/auth-files", {
          upstream_status: result.status,
          names: body.names,
        });
        if (!isOk(result.status)) return cpaFailure(result);
        return { ok: true };
      },
    )
    // ── Auth files: refresh token/credential state ───────────────────────────
    .post(
      "/api/v1/admin/cpa/auth-files/refresh",
      {
        detail: {
          tags: ["System"],
          summary: "Refresh CPA auth files",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        const result = await cpaCall("POST", "/v0/management/auth-files/refresh");
        await audit(
          db,
          g.userId,
          "cpa.auth_file.refresh",
          "cpa:/v0/management/auth-files/refresh",
          {
            upstream_status: result.status,
          },
        );
        if (!isOk(result.status)) return cpaFailure(result);
        return { ok: true };
      },
    )
    // ── Routing strategy ─────────────────────────────────────────────────────
    .put(
      "/api/v1/admin/cpa/routing/strategy",
      {
        body: t.Object({ strategy: t.Union(ROUTING_STRATEGIES.map((s) => t.Literal(s))) }, strict),
        detail: {
          tags: ["System"],
          summary: "Set CPA credential routing strategy",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        const result = await cpaCall(
          "PUT",
          "/v0/management/routing/strategy",
          JSON.stringify({ value: body.strategy }),
        );
        await audit(db, g.userId, "cpa.routing.strategy", "cpa:/v0/management/routing/strategy", {
          upstream_status: result.status,
          strategy: body.strategy,
        });
        if (!isOk(result.status)) return cpaFailure(result);
        return { ok: true };
      },
    )
    // ── Model alias mapping per OAuth channel ────────────────────────────────
    .put(
      "/api/v1/admin/cpa/model-alias",
      {
        body: t.Object(
          {
            channel: t.String({ minLength: 1, maxLength: 64 }),
            aliases: t.Array(
              t.Object(
                {
                  name: t.String({ minLength: 1, maxLength: 255 }),
                  alias: t.String({ minLength: 1, maxLength: 255 }),
                  fork: t.Optional(t.Boolean()),
                  display_name: t.Optional(t.String({ maxLength: 255 })),
                  force_mapping: t.Optional(t.Boolean()),
                },
                strict,
              ),
              { maxItems: 200 },
            ),
          },
          strict,
        ),
        detail: {
          tags: ["System"],
          summary: "Replace or clear CPA OAuth channel model aliases",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        // CPA PATCH /oauth-model-alias: empty aliases removes the channel's
        // mappings; non-empty replaces them. JSON field names are CPA's
        // yaml-style keys (display-name, force-mapping).
        const aliases = body.aliases.map((a) => ({
          name: a.name,
          alias: a.alias,
          ...(a.fork !== undefined ? { fork: a.fork } : {}),
          ...(a.display_name !== undefined ? { "display-name": a.display_name } : {}),
          ...(a.force_mapping !== undefined ? { "force-mapping": a.force_mapping } : {}),
        }));
        const result = await cpaCall(
          "PATCH",
          "/v0/management/oauth-model-alias",
          JSON.stringify({ channel: body.channel, aliases }),
        );
        await audit(
          db,
          g.userId,
          "cpa.model_alias.update",
          "cpa:/v0/management/oauth-model-alias",
          {
            upstream_status: result.status,
            channel: body.channel,
            alias_count: aliases.length,
          },
        );
        if (!isOk(result.status)) return cpaFailure(result);
        return { ok: true };
      },
    )
    // ── Per-channel excluded models ──────────────────────────────────────────
    .put(
      "/api/v1/admin/cpa/model-exclusions",
      {
        body: t.Object(
          {
            channel: t.String({ minLength: 1, maxLength: 64 }),
            models: t.Array(t.String({ minLength: 1, maxLength: 255 }), { maxItems: 500 }),
          },
          strict,
        ),
        detail: {
          tags: ["System"],
          summary: "Replace or clear CPA OAuth channel model exclusions",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await gateAdmin(db, auth, request);
        if (g instanceof Response) return g;
        // CPA PATCH /oauth-excluded-models: empty models removes the channel.
        const result = await cpaCall(
          "PATCH",
          "/v0/management/oauth-excluded-models",
          JSON.stringify({ provider: body.channel, models: body.models }),
        );
        await audit(
          db,
          g.userId,
          "cpa.model_exclusions.update",
          "cpa:/v0/management/oauth-excluded-models",
          {
            upstream_status: result.status,
            channel: body.channel,
            model_count: body.models.length,
          },
        );
        if (!isOk(result.status)) return cpaFailure(result);
        return { ok: true };
      },
    );
