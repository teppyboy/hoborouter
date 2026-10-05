// Dashboard read endpoints for workspace members (min role member).
// Read-only: usage logs, usage summary, wallet, ledger, payments.
// Money/token integers are schema-bounded to safe range -> returned as JSON numbers.
// No secrets: key_prefix only (never key_hash), no raw provider payloads.
import { Elysia, t } from "elysia";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole } from "../authz";
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import {
  type Db,
  usageLogs,
  apiKeys,
  wallets,
  ledgerEntries,
  billingReservations,
  payments,
  requests as requestsTable,
  subscriptionPlans,
  subscriptions,
} from "@hoborouter/db";
import { applySubscriptionExpiry, runInImmediate } from "@hoborouter/wallet";

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

export const dashboardRoutes = (db: Db, auth: BetterAuthInstance) =>
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
        const denied = await requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        const limit = parseLimit(query?.limit);
        const before = typeof query?.before === "string" ? parseInt(query.before, 10) : NaN;
        const rowShape = {
          id: usageLogs.id,
          request_id: usageLogs.request_id,
          created_at: usageLogs.created_at,
          public_model: usageLogs.public_model,
          provider: usageLogs.provider,
          status: usageLogs.status,
          failure: usageLogs.failure,
          input_tokens: usageLogs.input_tokens,
          output_tokens: usageLogs.output_tokens,
          cached_input_tokens: usageLogs.cached_input_tokens,
          reasoning_tokens: usageLogs.reasoning_tokens,
          charged_vnd: usageLogs.charged_vnd,
          latency_ms: usageLogs.latency_ms,
          ttft_ms: usageLogs.ttft_ms,
          key_prefix: apiKeys.key_prefix,
        };
        // Admin-soft-deleted requests are hidden from the customer log list.
        const notDeleted = () => isNull(requestsTable.deleted_at);
        const rows = Number.isFinite(before)
          ? await db
              .select(rowShape)
              .from(usageLogs)
              .leftJoin(apiKeys, eq(apiKeys.id, usageLogs.api_key_id))
              .leftJoin(requestsTable, eq(requestsTable.id, usageLogs.request_id))
              .where(
                and(
                  eq(usageLogs.workspace_id, params.id),
                  lt(usageLogs.created_at, before),
                  notDeleted(),
                ),
              )
              .orderBy(desc(usageLogs.created_at))
              .limit(limit)
          : await db
              .select(rowShape)
              .from(usageLogs)
              .leftJoin(apiKeys, eq(apiKeys.id, usageLogs.api_key_id))
              .leftJoin(requestsTable, eq(requestsTable.id, usageLogs.request_id))
              .where(and(eq(usageLogs.workspace_id, params.id), notDeleted()))
              .orderBy(desc(usageLogs.created_at))
              .limit(limit);
        return { data: rows };
      },
    )
    .get(
      "/api/v1/workspaces/:id/usage-summary",
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          days: t.Optional(t.String()),
          model: t.Optional(t.String()),
        }),
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
        const denied = await requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        const daysRaw = typeof query?.days === "string" ? parseInt(query.days, 10) : NaN;
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 30;
        // Exact window: days UTC calendar days ending today. Rolling now-based
        // windows can spill into days+1 daily buckets (today + yesterday + ...).
        const now = new Date();
        const since =
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
          (days - 1) * 24 * 60 * 60 * 1000;
        // Optional public_model filter — applied identically to totals, daily, by_model.
        const model = typeof query?.model === "string" && query.model !== "" ? query.model : null;
        const scope = () =>
          and(
            eq(usageLogs.workspace_id, params.id),
            gte(usageLogs.created_at, since),
            ...(model ? [eq(usageLogs.public_model, model)] : []),
          );
        const errExpr =
          sql<number>`case when ${usageLogs.status} != 'ok' then 1 else 0 end`.mapWith(Number);
        // Visibility gate — mirrors web/src/pages/logs/filters.ts visibleRows:
        // hide rows with missing/blank public_model, or with both token counts 0.
        // Soft-deleted requests are excluded from visibility-gated counts only.
        // Financial totals (spend/tokens/requests) deliberately include them:
        // removing a log never moves money or rewrites spend history.
        const notDeletedSql = sql`not exists (select 1 from requests r where r.id = ${usageLogs.request_id} and r.deleted_at is not null)`;
        const visibleExpr =
          sql<number>`case when ${usageLogs.public_model} is not null and trim(${usageLogs.public_model}) != '' and not (${usageLogs.input_tokens} = 0 and ${usageLogs.output_tokens} = 0) and ${notDeletedSql} then 1 else 0 end`.mapWith(
            Number,
          );
        const visibleErrExpr =
          sql<number>`case when ${usageLogs.status} != 'ok' and ${usageLogs.public_model} is not null and trim(${usageLogs.public_model}) != '' and not (${usageLogs.input_tokens} = 0 and ${usageLogs.output_tokens} = 0) and ${notDeletedSql} then 1 else 0 end`.mapWith(
            Number,
          );
        const totalsRows = await db
          .select({
            requests: sql<number>`count(*)`.mapWith(Number),
            spend_vnd: sql<number>`coalesce(sum(coalesce(${usageLogs.charged_vnd}, 0)), 0)`.mapWith(
              Number,
            ),
            input_tokens: sql<number>`coalesce(sum(${usageLogs.input_tokens}), 0)`.mapWith(Number),
            output_tokens: sql<number>`coalesce(sum(${usageLogs.output_tokens}), 0)`.mapWith(
              Number,
            ),
            errors: sql<number>`coalesce(sum(${errExpr}), 0)`.mapWith(Number),
            visible_requests: sql<number>`coalesce(sum(${visibleExpr}), 0)`.mapWith(Number),
            visible_errors: sql<number>`coalesce(sum(${visibleErrExpr}), 0)`.mapWith(Number),
          })
          .from(usageLogs)
          .where(scope())
          .limit(1);
        const totals = totalsRows[0];
        // UTC calendar-day buckets; to_char(to_timestamp(...)) keeps the exact
        // UTC window semantics of the old SQLite date(...,'unixepoch').
        const dayExpr = sql<string>`to_char(to_timestamp(${usageLogs.created_at} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD')`;
        const daily = await db
          .select({
            day: dayExpr.as("day"),
            requests: sql<number>`count(*)`.mapWith(Number),
            spend_vnd: sql<number>`coalesce(sum(coalesce(${usageLogs.charged_vnd}, 0)), 0)`.mapWith(
              Number,
            ),
            tokens:
              sql<number>`coalesce(sum(${usageLogs.input_tokens} + ${usageLogs.output_tokens}), 0)`.mapWith(
                Number,
              ),
            errors: sql<number>`coalesce(sum(${errExpr}), 0)`.mapWith(Number),
          })
          .from(usageLogs)
          .where(scope())
          .groupBy(dayExpr)
          .orderBy(sql`day`);
        const by_model = await db
          .select({
            public_model: usageLogs.public_model,
            requests: sql<number>`count(*)`.mapWith(Number),
            spend_vnd: sql<number>`coalesce(sum(coalesce(${usageLogs.charged_vnd}, 0)), 0)`.mapWith(
              Number,
            ),
            tokens:
              sql<number>`coalesce(sum(${usageLogs.input_tokens} + ${usageLogs.output_tokens}), 0)`.mapWith(
                Number,
              ),
          })
          .from(usageLogs)
          .where(scope())
          .groupBy(usageLogs.public_model)
          .orderBy(sql`coalesce(sum(coalesce(${usageLogs.charged_vnd}, 0)), 0) desc`);
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
        const denied = await requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        const w = await db
          .select({
            currency: wallets.currency,
            balance: wallets.balance,
            reserved: wallets.reserved,
          })
          .from(wallets)
          .where(and(eq(wallets.workspace_id, params.id), eq(wallets.kind, "topup")))
          .limit(1);
        const rate = usdVndRate();
        // O5: reading for display applies lazy expiry (idempotent forfeit of an
        // ended period's unused subscription credit) inside one transaction.
        const now = Date.now();
        const sub = await runInImmediate(db, async (tx) => {
          await applySubscriptionExpiry(tx, params.id, now);
          const rows = await tx
            .select({
              balance: wallets.balance,
              reserved: wallets.reserved,
              period_end: subscriptions.current_period_end,
              canceled_at: subscriptions.canceled_at,
              plan_name: subscriptionPlans.name,
              rate_limit_per_minute: subscriptionPlans.rate_limit_per_minute,
            })
            .from(subscriptions)
            .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.plan_id))
            .innerJoin(
              wallets,
              and(
                eq(wallets.workspace_id, subscriptions.workspace_id),
                eq(wallets.kind, "subscription"),
              ),
            )
            .where(
              and(eq(subscriptions.workspace_id, params.id), eq(subscriptions.status, "active")),
            )
            .limit(1);
          return rows[0] ?? null;
        });
        // Keep the existing top-level fields byte-identical; `subscription`
        // is additive. Active-status row with an ended period still shows (so
        // the UI can offer renewal) with expired: true; no row at all = null.
        const subscription = sub
          ? {
              balance: sub.balance,
              available: sub.balance - sub.reserved,
              period_end: sub.period_end,
              // Cancel marker (decision b): informational only — credit stays
              // spendable through period_end and expiry is unchanged.
              canceled: sub.canceled_at !== null,
              plan_name: sub.plan_name,
              rate_limit_per_minute: sub.rate_limit_per_minute,
              expired: sub.period_end <= now,
            }
          : null;
        if (!w[0])
          return {
            currency: "VND",
            balance: 0,
            reserved: 0,
            available: 0,
            usd_vnd_rate: rate,
            subscription,
          };
        return {
          currency: w[0].currency,
          balance: w[0].balance,
          reserved: w[0].reserved,
          available: w[0].balance - w[0].reserved,
          usd_vnd_rate: rate,
          subscription,
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
        const denied = await requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        const limit = parseLimit(query?.limit);
        // Both wallet kinds are shown: filtering kind='topup' hid all
        // subscription financial history (credits, settles, refunds, expiry
        // forfeits). `wallet_kind` is additive so each row names its source
        // wallet; balance_after is that row's own wallet snapshot, never an
        // aggregate across kinds.
        const rows = await db
          .select({
            id: ledgerEntries.id,
            created_at: ledgerEntries.created_at,
            direction: ledgerEntries.direction,
            kind: ledgerEntries.kind,
            amount: ledgerEntries.amount,
            balance_after: ledgerEntries.balance_after,
            memo: ledgerEntries.memo,
            payment_id: ledgerEntries.payment_id,
            request_id: billingReservations.request_id,
            wallet_kind: wallets.kind,
          })
          .from(ledgerEntries)
          .innerJoin(wallets, eq(wallets.id, ledgerEntries.wallet_id))
          .leftJoin(
            billingReservations,
            eq(billingReservations.id, ledgerEntries.billing_reservation_id),
          )
          .where(eq(wallets.workspace_id, params.id))
          .orderBy(desc(ledgerEntries.created_at))
          .limit(limit);
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
        const denied = await requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        const limit = parseLimit(query?.limit);
        // no checkout_url column exists on payments — omitted per spec
        const rows = await db
          .select({
            id: payments.id,
            provider: payments.provider,
            amount: payments.amount,
            status: payments.status,
            created_at: payments.created_at,
            provider_order_code: payments.provider_order_code,
          })
          .from(payments)
          .where(eq(payments.workspace_id, params.id))
          .orderBy(desc(payments.created_at))
          .limit(limit);
        return { data: rows };
      },
    );
