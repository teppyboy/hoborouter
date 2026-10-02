// Dashboard read endpoints for workspace members (min role member).
// Read-only: usage logs, usage summary, wallet, ledger, payments.
// Money/token integers are schema-bounded to safe range -> returned as JSON numbers.
// No secrets: key_prefix only (never key_hash), no raw provider payloads.
import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole } from "../authz";

// Same FX source billing uses: HBR_USD_VND_RATE, default 26000 (see v1-gateway/admin-extra).
const usdVndRate = () => {
  const n = Number(process.env.HBR_USD_VND_RATE);
  return Number.isSafeInteger(n) && n > 0 ? n : 26000;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: unknown): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export const dashboardRoutes = (db: Database, auth: BetterAuthInstance) =>
  new Elysia({ name: "dashboard" })
    .get(
      "/api/v1/workspaces/:id/usage-logs",
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          limit: t.Optional(t.String()),
          before: t.Optional(t.String()),
        }),
        detail: {
          tags: ["Dashboard"],
          summary: "List usage logs",
          description: "Paginated usage log rows for a workspace (member+).",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, query }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        const limit = parseLimit(query?.limit);
        const before = typeof query?.before === "string" ? parseInt(query.before, 10) : NaN;
        const rows = Number.isFinite(before)
          ? db
              .prepare(
                `SELECT ul.id, ul.request_id, ul.created_at, ul.public_model, ul.provider,
                      ul.status, ul.failure, ul.input_tokens, ul.output_tokens,
                      ul.cached_input_tokens, ul.reasoning_tokens, ul.charged_vnd, ul.latency_ms,
                      ul.ttft_ms, k.key_prefix
               FROM usage_logs ul LEFT JOIN api_keys k ON k.id = ul.api_key_id
               WHERE ul.workspace_id = ? AND ul.created_at < ?
               ORDER BY ul.created_at DESC LIMIT ?`,
              )
              .all(params.id, before, limit)
          : db
              .prepare(
                `SELECT ul.id, ul.request_id, ul.created_at, ul.public_model, ul.provider,
                      ul.status, ul.failure, ul.input_tokens, ul.output_tokens,
                      ul.cached_input_tokens, ul.reasoning_tokens, ul.charged_vnd, ul.latency_ms,
                      ul.ttft_ms, k.key_prefix
               FROM usage_logs ul LEFT JOIN api_keys k ON k.id = ul.api_key_id
               WHERE ul.workspace_id = ?
               ORDER BY ul.created_at DESC LIMIT ?`,
              )
              .all(params.id, limit);
        return { data: rows };
      },
    )
    .get(
      "/api/v1/workspaces/:id/usage-summary",
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ days: t.Optional(t.String()) }),
        detail: {
          tags: ["Dashboard"],
          summary: "Usage summary",
          description: "Aggregate totals, daily series, and per-model breakdown (member+).",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, query }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        const daysRaw = typeof query?.days === "string" ? parseInt(query.days, 10) : NaN;
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 30;
        const since = Date.now() - days * 24 * 60 * 60 * 1000;
        const errExpr = `CASE WHEN status != 'ok' THEN 1 ELSE 0 END`;
        const totals = db
          .prepare(
            `SELECT COUNT(*) AS requests,
                  COALESCE(SUM(COALESCE(charged_vnd, 0)), 0) AS spend_vnd,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(${errExpr}), 0) AS errors
           FROM usage_logs WHERE workspace_id = ? AND created_at >= ?`,
          )
          .get(params.id, since) as {
          requests: number;
          spend_vnd: number;
          input_tokens: number;
          output_tokens: number;
          errors: number;
        };
        const daily = db
          .prepare(
            `SELECT date(created_at / 1000, 'unixepoch') AS day,
                  COUNT(*) AS requests,
                  COALESCE(SUM(COALESCE(charged_vnd, 0)), 0) AS spend_vnd,
                  COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
           FROM usage_logs WHERE workspace_id = ? AND created_at >= ?
           GROUP BY day ORDER BY day`,
          )
          .all(params.id, since) as {
          day: string;
          requests: number;
          spend_vnd: number;
          tokens: number;
        }[];
        const by_model = db
          .prepare(
            `SELECT public_model,
                  COUNT(*) AS requests,
                  COALESCE(SUM(COALESCE(charged_vnd, 0)), 0) AS spend_vnd,
                  COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
           FROM usage_logs WHERE workspace_id = ? AND created_at >= ?
           GROUP BY public_model ORDER BY spend_vnd DESC`,
          )
          .all(params.id, since) as {
          public_model: string;
          requests: number;
          spend_vnd: number;
          tokens: number;
        }[];
        return { totals, daily, by_model };
      },
    )

    .get(
      "/api/v1/workspaces/:id/wallet",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Dashboard"],
          summary: "Get wallet",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        const w = db
          .prepare("SELECT currency, balance, reserved FROM wallets WHERE workspace_id = ?")
          .get(params.id) as { currency: string; balance: number; reserved: number } | undefined;
        const rate = usdVndRate();
        if (!w) return { currency: "VND", balance: 0, reserved: 0, available: 0, usd_vnd_rate: rate };
        return {
          currency: w.currency,
          balance: w.balance,
          reserved: w.reserved,
          available: w.balance - w.reserved,
          usd_vnd_rate: rate,
        };
      },
    )

    .get(
      "/api/v1/workspaces/:id/ledger",
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ limit: t.Optional(t.String()) }),
        detail: {
          tags: ["Dashboard"],
          summary: "List ledger entries",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, query }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        const limit = parseLimit(query?.limit);
        const rows = db
          .prepare(
            `SELECT le.id, le.created_at, le.direction, le.kind, le.amount, le.balance_after,
                  le.memo, le.payment_id, br.request_id
           FROM ledger_entries le
           JOIN wallets w ON w.id = le.wallet_id
           LEFT JOIN billing_reservations br ON br.id = le.billing_reservation_id
           WHERE w.workspace_id = ?
           ORDER BY le.created_at DESC LIMIT ?`,
          )
          .all(params.id, limit) as Record<string, unknown>[];
        return { data: rows };
      },
    )

    .get(
      "/api/v1/workspaces/:id/payments",
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ limit: t.Optional(t.String()) }),
        detail: {
          tags: ["Dashboard"],
          summary: "List payments",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, query }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        const limit = parseLimit(query?.limit);
        // no checkout_url column exists on payments — omitted per spec
        const rows = db
          .prepare(
            `SELECT id, provider, amount, status, created_at, provider_order_code
           FROM payments WHERE workspace_id = ?
           ORDER BY created_at DESC LIMIT ?`,
          )
          .all(params.id, limit);
        return { data: rows };
      },
    );
