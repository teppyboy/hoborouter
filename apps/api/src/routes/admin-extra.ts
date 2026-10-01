// Admin-extra: instance-admin-only overview routes (users, payments,
// usage-logs, CPA model discovery, system status). No secrets ever emitted:
// no key hashes, no raw provider payloads, no env values — booleans only.
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, jsonError } from "../authz";

const cpaBase = () => process.env.CPA_BASE_URL || "http://cpa:8317";

async function guard(db: Database, auth: BetterAuthInstance, request: Request) {
  const gate = await requireSession(auth, request);
  if ("error" in gate) return { error: gate.error } as const;
  const denied = requireInstanceAdmin(db, gate.session.user.id);
  if (denied) return { error: denied } as const;
  return { session: gate.session } as const;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const adminExtraRoutes = (db: Database, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-extra" })
    .get("/api/admin/users", async ({ request }) => {
      const g = await guard(db, auth, request);
      if ("error" in g) return g.error;
      const rows = db
        .prepare(
          `SELECT u.id, u.email, u.name, u.created_at,
                  EXISTS(SELECT 1 FROM instance_admins ia WHERE ia.user_id = u.id) AS is_instance_admin,
                  (SELECT COUNT(*) FROM workspace_members wm WHERE wm.user_id = u.id) AS workspace_count
           FROM users u ORDER BY u.created_at DESC`,
        )
        .all();
      return json({ data: rows });
    })
    .get("/api/admin/payments", async ({ request }) => {
      const g = await guard(db, auth, request);
      if ("error" in g) return g.error;
      // provider_order_code is the merchant-facing code, not a secret; raw
      // payloads live in payment_events and are never joined here.
      const rows = db
        .prepare(
          `SELECT p.id, p.workspace_id, w.name AS workspace_name, p.amount, p.status,
                  p.provider, p.provider_order_code, p.created_at, p.expires_at
           FROM payments p JOIN workspaces w ON w.id = p.workspace_id
           ORDER BY p.created_at DESC LIMIT 200`,
        )
        .all();
      return json({ data: rows });
    })
    .get("/api/admin/usage-logs", async ({ request }) => {
      const g = await guard(db, auth, request);
      if ("error" in g) return g.error;
      // raw_payload excluded — may contain upstream response data.
      const rows = db
        .prepare(
          `SELECT ul.id, ul.workspace_id, w.name AS workspace_name,
                  k.key_prefix, ul.provider, ul.public_model, ul.upstream_model,
                  ul.input_tokens, ul.output_tokens, ul.cached_input_tokens,
                  ul.reasoning_tokens, ul.status, ul.failure, ul.latency_ms,
                  ul.upstream_cost_usd_micro, ul.charged_vnd, ul.created_at
           FROM usage_logs ul
           JOIN workspaces w ON w.id = ul.workspace_id
           LEFT JOIN api_keys k ON k.id = ul.api_key_id
           ORDER BY ul.created_at DESC LIMIT 200`,
        )
        .all();
      return json({ data: rows });
    })
    .get("/api/admin/cpa/models", async ({ request }) => {
      const g = await guard(db, auth, request);
      if ("error" in g) return g.error;
      const key = process.env.CPA_ACCESS_KEY;
      if (!key) return jsonError(502, "CPA_UNCONFIGURED", "CPA_ACCESS_KEY is not set");
      let resp: Response;
      try {
        resp = await fetch(`${cpaBase()}/v1/models`, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        return jsonError(502, "CPA_UNREACHABLE", "CPA did not respond");
      }
      if (!resp.ok) return jsonError(502, "CPA_UNHEALTHY", `/v1/models returned ${resp.status}`);
      type Model = { id?: unknown; owned_by?: unknown };
      let upstream: { data?: Model[] };
      try {
        upstream = (await resp.json()) as { data?: Model[] };
      } catch {
        return jsonError(502, "CPA_UNHEALTHY", "invalid /v1/models response");
      }
      const mapped = new Set(
        (
          db
            .prepare("SELECT DISTINCT upstream_model FROM provider_model_mappings")
            .all() as { upstream_model: string }[]
        ).map((r) => r.upstream_model),
      );
      const data = (upstream.data ?? [])
        .filter((m): m is { id: string; owned_by?: string } => typeof m.id === "string")
        .map((m) => ({
          id: m.id,
          owned_by: typeof m.owned_by === "string" ? m.owned_by : null,
          mapped: mapped.has(m.id),
        }));
      return json({ data });
    })
    .get("/api/admin/system", async ({ request }) => {
      const g = await guard(db, auth, request);
      if ("error" in g) return g.error;
      const count = (t: string) =>
        (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
      const wal = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
        .journal_mode;
      return json({
        gateway_enabled: process.env.HBR_GATEWAY_ENABLED === "1",
        usd_vnd_rate: Number(process.env.HBR_USD_VND_RATE) || 26000,
        payos_configured:
          !!process.env.PAYOS_CLIENT_ID &&
          !!process.env.PAYOS_API_KEY &&
          !!process.env.PAYOS_CHECKSUM_KEY,
        dev_payments: process.env.HBR_DEV_PAYMENTS === "1",
        db: { wal },
        counts: {
          users: count("users"),
          workspaces: count("workspaces"),
          models: count("models"),
          requests: count("requests"),
        },
      });
    });
