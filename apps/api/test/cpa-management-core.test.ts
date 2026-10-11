// Focused unit tests for the CPA management proxy core: strict allowlist,
// field-name redaction, secret-value scrubbing, safe error mapping, and the
// audit helper (detail never carries the management key). No DB or network.
import { describe, expect, test } from "bun:test";
import {
  auditCpaManagement,
  handleCpaManagementProxy,
  isAllowedManagementPath,
  mapCpaManagementError,
  redactManagementPayload,
  redactFields,
  REDACTED,
} from "../src/cpa-management-core";
import { auditLog } from "@hoborouter/db";
import type { BetterAuthInstance } from "../src/auth-types";

describe("isAllowedManagementPath", () => {
  test("exact allowlisted GET paths pass", () => {
    expect(isAllowedManagementPath("GET", "/v0/management/config")).toBe(true);
    expect(isAllowedManagementPath("GET", "/v0/management/usage-queue?count=10")).toBe(true);
  });

  test("non-GET methods are rejected even on allowlisted paths", () => {
    expect(isAllowedManagementPath("POST", "/v0/management/config")).toBe(false);
    expect(isAllowedManagementPath("DELETE", "/v0/management/config")).toBe(false);
  });

  test("mutating /v0/management paths are not allowlisted", () => {
    // No mutation entries exist yet; any path outside the allowlist is denied.
    expect(isAllowedManagementPath("PUT", "/v0/management/config/reload")).toBe(false);
    expect(isAllowedManagementPath("POST", "/v0/management/api-keys")).toBe(false);
  });

  test("anything outside /v0/management is rejected", () => {
    expect(isAllowedManagementPath("GET", "/v1/chat/completions")).toBe(false);
    expect(isAllowedManagementPath("GET", "/healthz")).toBe(false);
    expect(isAllowedManagementPath("GET", "/v0/management")).toBe(false);
    expect(isAllowedManagementPath("GET", "/v0/management/")).toBe(false);
    expect(isAllowedManagementPath("GET", "/v8/management/config")).toBe(false);
  });

  test("prefix, traversal, and encoding tricks are rejected", () => {
    expect(isAllowedManagementPath("GET", "/v0/management/config/extra")).toBe(false);
    expect(isAllowedManagementPath("GET", "/v0/management/../management/config")).toBe(false);
    expect(isAllowedManagementPath("GET", "/v0/management/%63onfig")).toBe(false);
    expect(isAllowedManagementPath("GET", "/v0/management/config%00")).toBe(false);
    expect(isAllowedManagementPath("GET", "/v0/management\\config")).toBe(false);
  });
});

describe("redactFields", () => {
  test("redacts secret-named fields at any depth, keeps their slot", () => {
    const out = redactFields({
      api_key: "sk-live",
      nested: { secretKey: "abc", auth: "bearer-x", ok: 1 },
      list: [{ token: "t", keep: "v" }],
    });
    expect(out).toEqual({
      api_key: REDACTED,
      nested: { secretKey: REDACTED, auth: REDACTED, ok: 1 },
      list: [{ token: REDACTED, keep: "v" }],
    });
  });

  test("leaves non-secret fields and scalars untouched", () => {
    expect(redactFields({ model: "gpt", count: 3, flag: true, nil: null })).toEqual({
      model: "gpt",
      count: 3,
      flag: true,
      nil: null,
    });
    expect(redactFields("plain")).toBe("plain");
  });

  test("redacted values are never the original secret", () => {
    const out = JSON.stringify(redactFields({ "x-api-key": "supersecret-value" }));
    expect(out).not.toContain("supersecret-value");
  });
});

describe("redactManagementPayload", () => {
  test("scrubs literal secret values anywhere in the serialized body", () => {
    const mgmtKey = "mgmt-secret-value-123";
    const body = {
      note: "key is mgmt-secret-value-123",
      api_key: "will-be-redacted-anyway",
      outer: { inner: "mgmt-secret-value-123" },
    };
    const text = redactManagementPayload(body, [mgmtKey]);
    expect(text).not.toContain(mgmtKey);
    expect(text).toContain(REDACTED);
    expect(JSON.parse(text).api_key).toBe(REDACTED);
  });

  test("empty secret entries are ignored", () => {
    expect(redactManagementPayload({ a: 1 }, [""])).toBe('{"a":1}');
  });
});

describe("mapCpaManagementError", () => {
  test("auth failures name the env var, never its value", () => {
    const e = mapCpaManagementError("auth", 401);
    expect(e.status).toBe(502);
    expect(e.code).toBe("CPA_AUTH_FAILED");
    expect(e.message).toBe("CPA rejected CPA_MANAGEMENT_KEY (401)");
    expect(e.message).not.toContain("value-of-key");
  });

  test("timeout and network failures are 502 CPA_UNREACHABLE", () => {
    for (const kind of ["timeout", "unreachable"] as const) {
      const e = mapCpaManagementError(kind);
      expect(e.status).toBe(502);
      expect(e.code).toBe("CPA_UNREACHABLE");
    }
  });

  test("upstream status and non-JSON body map to status-only messages", () => {
    const e = mapCpaManagementError("upstream_status", 500);
    expect(e.code).toBe("CPA_MANAGEMENT_UNAVAILABLE");
    expect(e.message).toBe("management returned 500");
    const j = mapCpaManagementError("invalid_response", 200);
    expect(j.code).toBe("CPA_MANAGEMENT_INVALID_RESPONSE");
  });
});

describe("management panel HTML is never served or proxied", () => {
  // The upstream control panel (management.html) is runtime-downloaded,
  // third-party executable HTML — see docs/architecture/cpa-management-panel.md.
  // These tests pin the prohibition: no panel path is proxyable, and the proxy
  // wildcard answers panel requests with JSON, never HTML.
  const adminAuth: BetterAuthInstance = {
    handler: async () => new Response(null, { status: 404 }),
    api: {
      getSession: async () => ({
        user: { id: "user-1" },
        session: { id: "sess-1", userId: "user-1" },
      }),
    },
  } as never;
  // Drizzle chain stub resolving isInstanceAdmin to true; the 404 path under
  // test never reaches audit or fetch.
  const adminDb = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ user_id: "user-1" }] }),
      }),
    }),
  } as never;

  test("panel and asset paths are rejected by the allowlist", () => {
    expect(isAllowedManagementPath("GET", "/v0/management/management.html")).toBe(false);
    expect(isAllowedManagementPath("GET", "/v0/management/control-panel.js")).toBe(false);
    expect(isAllowedManagementPath("GET", "/v0/management/assets/panel.css")).toBe(false);
    expect(isAllowedManagementPath("GET", "/v0/management/management.html.map")).toBe(false);
  });

  test("proxy wildcard answers a panel path with JSON 404, never HTML", async () => {
    const res = await handleCpaManagementProxy(
      adminDb,
      adminAuth,
      new Request("http://localhost/api/v1/admin/cpa/management/management.html"),
      { CPA_MANAGEMENT_KEY: "test-key-not-real" },
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.text();
    expect(body.startsWith("<")).toBe(false);
    expect(body).not.toContain("<script");
    expect(JSON.parse(body).error.code).toBe("CPA_MANAGEMENT_PATH_NOT_ALLOWED");
  });
});

describe("auditCpaManagement", () => {
  test("writes cpa.management.proxy with method/path only — no key, no payload", async () => {
    let captured: unknown = null;
    const fakeDb = {
      insert(_table: unknown) {
        return {
          async values(v: unknown) {
            captured = v;
          },
        };
      },
    } as never;
    await auditCpaManagement(fakeDb, {
      actorUserId: "user-1",
      method: "GET",
      path: "/v0/management/config",
      upstreamStatus: 200,
      latencyMs: 12,
    });
    const row = captured as Record<string, unknown>;
    expect(row.action).toBe("cpa.management.proxy");
    expect(row.target).toBe("GET /v0/management/config");
    expect(row.actor_user_id).toBe("user-1");
    const detail = row.detail as Record<string, unknown>;
    expect(detail).toEqual({ upstream_status: 200, latency_ms: 12 });
    expect(JSON.stringify(row)).not.toContain("mgmt-secret-value-123");
    // audit helper targets the shared auditLog table (sanity: same import).
    expect(auditLog).toBeDefined();
  });
});
