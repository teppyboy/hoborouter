// Admin-extra: instance-admin-only overview routes (users, payments,
// usage-logs, CPA model discovery, system status). No secrets ever emitted:
// no key hashes, no raw provider payloads, no env values — booleans only.
import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, isInstanceAdmin, jsonError, writeAudit } from "../authz";
import { MockPaymentError, processMockPaymentEvent } from "@hoborouter/payments";

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
    .get(
      "/api/v1/me",
      {
        detail: {
          tags: ["Admin"],
          summary: "Current session user",
          description:
            "Identity + instance-admin flag for any authenticated session (no admin required).",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const row = db
          .prepare("SELECT id, name, email FROM users WHERE id = ?")
          .get(userId) as { id: string; name: string; email: string } | undefined;
        if (!row) return jsonError(404, "NOT_FOUND", "User not found");
        return json({
          id: row.id,
          name: row.name,
          email: row.email,
          is_instance_admin: isInstanceAdmin(db, userId),
        });
      },
    )
    .get(
      "/api/v1/admin/users",
      {
        detail: {
          tags: ["Admin"],
          summary: "List users",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
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
      },
    )
    .get(
      "/api/v1/admin/payments",
      {
        detail: {
          tags: ["Billing"],
          summary: "List payments",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
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
      },
    )
    .get(
      "/api/v1/admin/usage-logs",
      {
        detail: {
          tags: ["Admin"],
          summary: "List usage logs",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
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
      },
    )
    .get(
      "/api/v1/admin/cpa/models",
      {
        detail: {
          tags: ["System"],
          summary: "List CPA models with mapping status",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
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
        if (resp.status === 401 || resp.status === 403)
          return jsonError(502, "CPA_AUTH_FAILED", `CPA rejected CPA_ACCESS_KEY (${resp.status})`);
        if (!resp.ok) return jsonError(502, "CPA_UNHEALTHY", `/v1/models returned ${resp.status}`);
        type Model = { id?: unknown; owned_by?: unknown };
        let upstream: { data?: Model[] };
        try {
          upstream = (await resp.json()) as { data?: Model[] };
        } catch {
          return jsonError(502, "CPA_UNHEALTHY", "invalid /v1/models response");
        }
        const mappedIds = db
          .prepare(
            "SELECT DISTINCT pm.upstream_model, m.public_id FROM provider_model_mappings pm JOIN models m ON m.id = pm.model_id WHERE pm.enabled = 1",
          )
          .all() as { upstream_model: string; public_id: string }[];
        const mapped = new Set(mappedIds.map((r) => r.upstream_model));
        const publicIdsByUpstream = new Map<string, string[]>();
        for (const r of mappedIds) {
          const list = publicIdsByUpstream.get(r.upstream_model);
          if (list) list.push(r.public_id);
          else publicIdsByUpstream.set(r.upstream_model, [r.public_id]);
        }
        const data = (upstream.data ?? [])
          .filter((m): m is { id: string; owned_by?: string } => typeof m.id === "string")
          .map((m) => ({
            id: m.id,
            owned_by: typeof m.owned_by === "string" ? m.owned_by : null,
            mapped: mapped.has(m.id),
            mapped_public_ids: publicIdsByUpstream.get(m.id) ?? [],
          }));
        return json({ data });
      },
    )
    .post(
      "/api/v1/admin/payments/:id/complete",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Billing"],
          summary: "Mark payment as received (admin credit)",
          description:
            "Instance-admin-only idempotent credit for out-of-band payment confirmation.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        // SECURITY: instance-admin-only in every environment. The owner confirms
        // money received out-of-band; ordinary users can never credit
        // themselves. Same idempotent credit path as dev-payments/webhooks.
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        const userId = g.session.user.id;
        const payment = db
          .prepare(
            "SELECT id, workspace_id, amount, status, provider, provider_order_code FROM payments WHERE id = ?",
          )
          .get(params.id) as
          | {
              id: string;
              workspace_id: string;
              amount: number;
              status: string;
              provider: string;
              provider_order_code: string;
            }
          | undefined;
        if (!payment) return jsonError(404, "NOT_FOUND", "Payment not found");
        try {
          const result = processMockPaymentEvent(db, {
            provider: payment.provider,
            orderCode: payment.provider_order_code,
            // Fixed reference per payment: replays are idempotent (already_processed).
            providerReference: `admin-complete-${payment.id}`,
            amount: payment.amount,
            rawPayload: JSON.stringify({ source: "admin-complete", paymentId: payment.id }),
          });
          writeAudit(db, {
            actorUserId: userId,
            workspaceId: payment.workspace_id,
            action: "payment.admin_complete",
            target: payment.id,
            detail: { outcome: result.outcome },
          });
          return new Response(JSON.stringify({ success: true, outcome: result.outcome }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        } catch (err) {
          if (err instanceof MockPaymentError) {
            if (err.code === "not_found") return jsonError(404, "NOT_FOUND", err.message);
            // e.g. cancelled/failed payment — invalid state, not a server error.
            return json({ error: { code: "INVALID_STATE", message: err.message } }, 409);
          }
          throw err;
        }
      },
    )
    .get(
      "/api/v1/admin/system",
      {
        detail: {
          tags: ["System"],
          summary: "System status",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        const count = (t: string) =>
          (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
        const wal = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
          .journal_mode;
        return json({
          gateway_enabled: process.env.HBR_GATEWAY_ENABLED !== "0",
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
      },
    );
