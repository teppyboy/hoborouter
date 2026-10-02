// Task 5: admin-only CPA health check. Instance admin only (requireInstanceAdmin).
// Each upstream probe is a SINGLE attempt — management auth failures are never
// retried. Upstream response bodies are never proxied (may contain credential
// metadata); the management key is never echoed into responses.
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, jsonError } from "../authz";

const cpaBase = () => process.env.CPA_BASE_URL || "http://cpa:8317";
const cpaMgmtKey = () => process.env.CPA_MANAGEMENT_KEY || "";

const fetchOnce = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(3000) });

export const cpaHealthRoutes = (db: Database, auth: BetterAuthInstance) =>
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
      const denied = requireInstanceAdmin(db, gate.session.user.id);
      if (denied) return denied;

      const key = cpaMgmtKey();
      if (!key) return jsonError(502, "CPA_UNCONFIGURED", "CPA_MANAGEMENT_KEY is not set");
      try {
        const health = await fetchOnce(`${cpaBase()}/healthz`);
        if (!health.ok) return jsonError(502, "CPA_UNHEALTHY", `healthz returned ${health.status}`);
        // single attempt, no retry loop
        const mgmt = await fetchOnce(`${cpaBase()}/v0/management/credentials/status`, {
          headers: { authorization: `Bearer ${key}` },
        });
        if (mgmt.status === 401 || mgmt.status === 403)
          return jsonError(
            502,
            "CPA_AUTH_FAILED",
            `CPA rejected CPA_MANAGEMENT_KEY (${mgmt.status})`,
          );
        if (!mgmt.ok)
          return jsonError(502, "CPA_MANAGEMENT_UNAVAILABLE", `management returned ${mgmt.status}`);
        return { status: "ok" };
      } catch {
        return jsonError(502, "CPA_UNREACHABLE", "CPA did not respond");
      }
    },
  );
