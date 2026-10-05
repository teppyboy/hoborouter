// Task 5: admin-only CPA health check. Instance admin only (requireInstanceAdmin).
// Each upstream probe is a SINGLE attempt — management auth failures are never
// retried. Upstream response bodies are never proxied (may contain credential
// metadata); the management key is never echoed into responses.
import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, jsonError } from "../authz";

const cpaBase = () => process.env.CPA_BASE_URL || "http://cpa:8317";
const cpaMgmtKey = () => process.env.CPA_MANAGEMENT_KEY || "";

const fetchOnce = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(3000) });

export const cpaHealthRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "cpahealth" }).get(
    "/api/v1/admin/cpa/health",
    {
      detail: {
        tags: ["System"],
        summary: "CPA health check",
        security: [{ cookieAuth: [] }],
      },
    },
    async ({ request }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const denied = await requireInstanceAdmin(db, gate.session.user.id);
      if (denied) return denied;

      const key = cpaMgmtKey();
      if (!key) return jsonError(502, "CPA_UNCONFIGURED", "CPA_MANAGEMENT_KEY is not set");
      // Host:port only — never the management key or any config contents.
      const host = new URL(cpaBase()).host;
      const started = performance.now();
      try {
        const health = await fetchOnce(`${cpaBase()}/healthz`);
        if (!health.ok) return jsonError(502, "CPA_UNHEALTHY", `healthz returned ${health.status}`);
        // single attempt, no retry loop. GET /v0/management/config exists on
        // CPA v8.x (GET /credentials/status does not — it is PATCH-only) and
        // proves management auth works; its body (secrets) is never returned.
        const mgmt = await fetchOnce(`${cpaBase()}/v0/management/config`, {
          headers: { authorization: `Bearer ${key}` },
        });
        const latency_ms = Math.round(performance.now() - started);
        if (mgmt.status === 401 || mgmt.status === 403)
          return jsonError(
            502,
            "CPA_AUTH_FAILED",
            `CPA rejected CPA_MANAGEMENT_KEY (${mgmt.status})`,
          );
        if (!mgmt.ok)
          return jsonError(502, "CPA_MANAGEMENT_UNAVAILABLE", `management returned ${mgmt.status}`);
        return {
          status: "ok" as const,
          proxy_endpoint: { healthy: true, http_status: health.status },
          management_api: { healthy: true, http_status: mgmt.status },
          latency_ms,
          cpa_host: host,
          checked_at: new Date().toISOString(),
        };
      } catch (err) {
        const detail =
          err instanceof Error && err.name === "TimeoutError" ? "timed out" : "did not respond";
        return jsonError(502, "CPA_UNREACHABLE", `CPA at ${host} ${detail}`);
      }
    },
  );
