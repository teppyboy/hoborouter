// CPA management proxy core (CPA pinned v8.0.4, legacy /v0/management API).
// Reusable building blocks for instance-admin-only server-side proxying of
// CPA management endpoints. This module registers no routes on its own —
// app.ts integration is owned by the caller (cpaManagementProxyRoutes is
// provided for that). The management key value never appears in any response,
// audit record, or error message.
import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import type { BetterAuthInstance } from "./auth-types";
import { requireSession, requireInstanceAdmin, jsonError, writeAudit } from "./authz";

// ---------------------------------------------------------------------------
// Env access
// ---------------------------------------------------------------------------

/** CPA base URL. Defaults to the compose-internal address, same as cpahealth. */
export const cpaBaseUrl = () => process.env.CPA_BASE_URL || "http://cpa:8317";

/**
 * Plaintext CPA_MANAGEMENT_KEY. Server-only: callers must never log, audit,
 * or serialize this value into a response.
 */
export const cpaManagementKey = () => process.env.CPA_MANAGEMENT_KEY || "";

export const CPA_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Strict /v0/management allowlist
// ---------------------------------------------------------------------------

export type CpaMgmtMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CpaMgmtEndpoint {
  method: CpaMgmtMethod;
  /** Exact path, no query string, no trailing slash. */
  path: string;
}

/**
 * Endpoints the proxy may reach. Mutations are deliberately absent until a
 * reviewed mutation endpoint list lands; extend with explicit entries only.
 * Verified read-only paths on CPA v8.0.4's legacy /v0/management surface.
 */
export const MANAGEMENT_ALLOWLIST: readonly CpaMgmtEndpoint[] = [
  { method: "GET", path: "/v0/management/config" },
  { method: "GET", path: "/v0/management/usage-queue" },
];

/**
 * Strict allowlist check. Exact string match on the raw path — no prefixes,
 * no wildcards, no normalization. Percent-escapes, backslashes, and dot
 * segments are rejected outright so encoded traversal cannot bypass the
 * match. Query strings are ignored here (allowed paths forward their query
 * upstream); they never participate in the match.
 */
export function isAllowedManagementPath(method: string, rawPath: string): boolean {
  const q = rawPath.indexOf("?");
  const path = q === -1 ? rawPath : rawPath.slice(0, q);
  if (!path.startsWith("/v0/management/")) return false;
  if (path.includes("%") || path.includes("\\") || path.includes("..")) return false;
  return MANAGEMENT_ALLOWLIST.some((e) => e.method === method && e.path === path);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export const REDACTED = "[REDACTED]";

// Substring match, case-insensitive: fail closed on near-miss names
// ("api-key", "secret_key", "authDir" … all redacted; false positives are
// harmless, false negatives are not).
const SECRET_FIELD_RE = /secret|token|key|password|passwd|auth|credential/i;

export type RedactedValue = null | boolean | number | string | RedactedValue[] | { [key: string]: RedactedValue };

/** Deep redaction by field name. Redacted fields keep their slot with REDACTED. */
export function redactFields(value: unknown): RedactedValue {
  const seen = new Set<object>();
  const walk = (v: unknown): RedactedValue => {
    if (v === null) return null;
    if (typeof v !== "object") {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
      return REDACTED;
    }
    if (seen.has(v as object)) return REDACTED;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: { [key: string]: RedactedValue } = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_FIELD_RE.test(k) ? REDACTED : walk(val);
    }
    return out;
  };
  return walk(value);
}

/**
 * Serialize a management payload as JSON after field-name redaction, then
 * scrub any literal secret values (management key, gateway access key) that
 * appear anywhere in the text — values nested under non-secret-named fields,
 * inside strings, or duplicated can still leak, so this is the final gate.
 */
export function redactManagementPayload(value: unknown, secrets: string[]): string {
  const text = JSON.stringify(redactFields(value)) ?? "null";
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join(REDACTED);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Safe error mapping
// ---------------------------------------------------------------------------

export interface CpaMgmtError {
  status: number;
  code: string;
  message: string;
}

/**
 * Map an upstream failure to a client-safe error. Messages carry at most the
 * CPA host (no key, no upstream body). Everything is 502: the proxy works,
 * CPA did not.
 */
export function mapCpaManagementError(
  kind: "auth" | "unreachable" | "timeout" | "upstream_status" | "invalid_response",
  upstreamStatus?: number,
): CpaMgmtError {
  let host = "invalid CPA host";
  try {
    host = new URL(cpaBaseUrl()).host;
  } catch {
    // Safe error mapping must never throw on invalid deployment config.
  }
  switch (kind) {
    case "auth":
      // Mirrors cpahealth's wording: names the env var, never its value.
      return {
        status: 502,
        code: "CPA_AUTH_FAILED",
        message: `CPA rejected CPA_MANAGEMENT_KEY (${upstreamStatus})`,
      };
    case "timeout":
      return { status: 502, code: "CPA_UNREACHABLE", message: `CPA at ${host} timed out` };
    case "unreachable":
      return { status: 502, code: "CPA_UNREACHABLE", message: `CPA at ${host} did not respond` };
    case "invalid_response":
      return {
        status: 502,
        code: "CPA_MANAGEMENT_INVALID_RESPONSE",
        message: `management returned a non-JSON body (${upstreamStatus})`,
      };
    case "upstream_status":
      return {
        status: 502,
        code: "CPA_MANAGEMENT_UNAVAILABLE",
        message: `management returned ${upstreamStatus}`,
      };
  }
}

function errorResponse(e: CpaMgmtError): Response {
  return jsonError(e.status, e.code, e.message);
}

// ---------------------------------------------------------------------------
// Upstream fetch (single attempt, 3s timeout)
// ---------------------------------------------------------------------------

export type CpaMgmtResult =
  | { ok: true; status: number; payload: unknown }
  | { ok: false; error: CpaMgmtError };

/**
 * One proxied management call. Single attempt — management auth failures are
 * never retried (same policy as the health probe). Error responses never
 * carry upstream bodies: bodies may contain credential metadata.
 */
export async function fetchCpaManagement(opts: {
  method: CpaMgmtMethod;
  /** Path including any query string, e.g. "/v0/management/usage-queue?count=10". */
  pathWithQuery: string;
}): Promise<CpaMgmtResult> {
  const key = cpaManagementKey();
  if (!key)
    return {
      ok: false,
      error: {
        status: 502,
        code: "CPA_UNCONFIGURED",
        message: "CPA_MANAGEMENT_KEY is not set",
      },
    };
  try {
    const res = await fetch(`${cpaBaseUrl()}${opts.pathWithQuery}`, {
      method: opts.method,
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(CPA_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403)
      return { ok: false, error: mapCpaManagementError("auth", res.status) };
    if (!res.ok) return { ok: false, error: mapCpaManagementError("upstream_status", res.status) };
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { ok: false, error: mapCpaManagementError("invalid_response", res.status) };
    }
    return { ok: true, status: res.status, payload };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return {
      ok: false,
      error: mapCpaManagementError(name === "TimeoutError" ? "timeout" : "unreachable"),
    };
  }
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

/**
 * Audit one proxied management call. Detail carries method/path/status only —
 * never the key, never the payload.
 */
export async function auditCpaManagement(
  db: Db,
  opts: {
    actorUserId: string;
    method: string;
    path: string;
    upstreamStatus?: number;
    latencyMs?: number;
  },
) {
  await writeAudit(db, {
    actorUserId: opts.actorUserId,
    workspaceId: null,
    action: "cpa.management.proxy",
    target: `${opts.method} ${opts.path}`,
    detail: {
      upstream_status: opts.upstreamStatus ?? null,
      latency_ms: opts.latencyMs ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Route helper (parent registers; nothing here touches app.ts)
// ---------------------------------------------------------------------------

/**
 * Instance-admin-only GET proxy under /api/v1/admin/cpa/management/*.
 * Session → instance admin → strict allowlist → upstream (3s, single
 * attempt) → redacted JSON response with no-store. Full pipeline shared by
 * every caller so per-route drift is impossible.
 */
export async function handleCpaManagementProxy(
  db: Db,
  auth: BetterAuthInstance,
  request: Request,
): Promise<Response> {
  const gate = await requireSession(auth, request);
  // `in`-narrowing alone leaves error as Response | undefined on this union;
  // bind it so the guard is honest instead of casted.
  const authFailure = "error" in gate ? gate.error : undefined;
  if (authFailure) return authFailure;
  const session = gate.session;
  if (!session) return jsonError(401, "UNAUTHORIZED", "Authentication required");
  const denied = await requireInstanceAdmin(db, session.user.id);
  if (denied) return denied;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return jsonError(400, "INVALID", "Invalid request URL");
  }
  // Route param form: /api/v1/admin/cpa/management/<remainder>.
  const remainder = url.pathname.replace(/^\/api\/v1\/admin\/cpa\/management\/?/, "");
  const upstreamPath = `/v0/management/${remainder}${url.search}`;

  if (!isAllowedManagementPath(request.method, upstreamPath)) {
    // Same response for "not allowlisted" and "does not exist": the proxy
    // surface must not reveal whether the path exists upstream.
    return jsonError(
      404,
      "CPA_MANAGEMENT_PATH_NOT_ALLOWED",
      "Requested CPA management path is not allowlisted",
    );
  }

  const started = performance.now();
  const result = await fetchCpaManagement({
    method: "GET",
    pathWithQuery: upstreamPath,
  });
  const latencyMs = Math.round(performance.now() - started);

  await auditCpaManagement(db, {
    actorUserId: session.user.id,
    method: request.method,
    path: upstreamPath,
    upstreamStatus: result.ok ? result.status : result.error.status,
    latencyMs,
  });

  if (!result.ok) return errorResponse(result.error);

  const secrets = [cpaManagementKey(), process.env.CPA_ACCESS_KEY ?? ""];
  return new Response(redactManagementPayload(result.payload, secrets), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Elysia plugin exposing the proxy. Caller `.use(...)`s this in app.ts. */
export const cpaManagementProxyRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "cpa-management-proxy" }).get(
    "/api/v1/admin/cpa/management/*",
    // Handler is passed inline (no detail hook object): the wildcard route's
    // LocalHook type rejects the handler+detail split used on fixed paths.
    ({ request }: { request: Request }) => handleCpaManagementProxy(db, auth, request),
  );
