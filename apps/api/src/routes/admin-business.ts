// Admin business report (BMC blocks 6/7/9): read-only financial + usage
// aggregates over usage_logs / payments / ledger_entries / wallets.
// Money-safety rules (docs/business/bmc-alignment.md P2-2):
// - Revenue sums the STORED usage_logs.charged_vnd — never recomputed from
//   current prices ("never recompute history" invariant).
// - Upstream cost in VND converts EACH row with its OWN stored
//   usd_vnd_exchange_rate (ceiling per row, mirroring billing's ceiling bias) —
//   never today's rate. Cost without a stored FX rate is reported separately,
//   never silently converted.
// - Cash receipts sum SUCCEEDED payments.amount (NOT ledger credits — promo /
//   bundle bonus / subscription grants also write credits and would inflate),
//   bucketed by paid day (payment_events.processed_at, durable event time),
//   not order-creation day.
// - Refunds are reported separately; usage revenue is gross, never netted.
// - realized_gross_margin_vnd = charged usage − converted upstream cost. It is
//   a realized gross margin on usage only, NOT cash profit (no infra/support/
//   payment costs, no cash-flow meaning).
// - Soft-deleted requests keep their usage_logs rows; financial totals include
//   them (deletion is display-only). No join to requests anywhere: no fanout,
//   no double counting.
// Precision: every money aggregate is returned as an exact decimal string
// (Postgres SUM over bigint is exact numeric). No float conversion, no
// MAX_SAFE_INTEGER overflow risk — clients format for display only.
import { Elysia, t } from "elysia";
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, jsonError } from "../authz";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Row-fetch helper for raw SQL reads; connection-level execute wraps rows in { rows }. */
async function rawRows<T>(db: Db, query: SQL): Promise<T[]> {
  const result: unknown = await db.execute(query);
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict UTC calendar date -> epoch-ms at 00:00 UTC; null when not a real date. */
function parseUtcDate(s: string): number | null {
  if (!DATE_RE.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== s) return null;
  return ms;
}

/** Per-row ceiling conversion of stored USD micro to VND at the row's own stored FX rate (null propagates). */
const costVndExpr = sql`ceil(ul.upstream_cost_usd_micro::numeric * ul.usd_vnd_exchange_rate / 1000000)`;

// Full-hold usage snapshots intentionally have no charged_vnd. Their actual
// debit is stored on the settlement ledger, linked through the reservation.
// Aggregate the link first so every usage row contributes at most one amount.
const chargedVndExpr = sql`CASE
  WHEN ul.status = 'full_hold' AND ul.charged_vnd IS NULL THEN fh.full_hold_charge_vnd
  ELSE ul.charged_vnd
END`;

/**
 * Aggregate list shared by totals / daily / by_model / by_workspace.
 * margin_incomplete_requests: charged rows whose upstream cost cannot be
 * converted (cost micro unknown OR stored FX rate missing). Their margin
 * contribution is NOT computed (never assumed zero) — any bucket carrying
 * such rows reports margin_provisional=true so the report never presents an
 * overstated margin as guaranteed.
 */
const aggregates = sql`
  count(*)::int AS requests,
  coalesce(sum(${chargedVndExpr}), 0)::text AS charged_vnd,
  coalesce(sum(ul.upstream_cost_usd_micro), 0)::text AS upstream_cost_usd_micro,
  coalesce(sum(${costVndExpr}) FILTER (WHERE ul.upstream_cost_usd_micro IS NOT NULL AND ul.usd_vnd_exchange_rate IS NOT NULL), 0)::text AS upstream_cost_vnd,
  coalesce(sum(ul.upstream_cost_usd_micro) FILTER (WHERE ul.upstream_cost_usd_micro IS NOT NULL AND ul.usd_vnd_exchange_rate IS NULL), 0)::text AS upstream_missing_fx_usd_micro,
  (count(*) FILTER (WHERE ${chargedVndExpr} IS NOT NULL AND (ul.upstream_cost_usd_micro IS NULL OR ul.usd_vnd_exchange_rate IS NULL)))::int AS margin_incomplete_requests,
  (coalesce(sum(${chargedVndExpr}), 0)
    - coalesce(sum(${costVndExpr}) FILTER (WHERE ul.upstream_cost_usd_micro IS NOT NULL AND ul.usd_vnd_exchange_rate IS NOT NULL), 0)
  )::text AS realized_gross_margin_vnd`;

/** FROM clause first, WHERE second — the workspace breakdown adds a JOIN before the range predicate. */
const usageFrom = (joinWorkspaces: boolean): SQL =>
  joinWorkspaces
    ? sql`FROM usage_logs ul
      LEFT JOIN LATERAL (
        SELECT sum(le.amount)::numeric AS full_hold_charge_vnd
        FROM billing_reservations br
        JOIN ledger_entries le ON le.billing_reservation_id = br.id
          AND le.kind = 'settle' AND le.direction = 'debit'
        WHERE br.request_id = ul.request_id
      ) fh ON true
      LEFT JOIN workspaces w ON w.id = ul.workspace_id`
    : sql`FROM usage_logs ul
      LEFT JOIN LATERAL (
        SELECT sum(le.amount)::numeric AS full_hold_charge_vnd
        FROM billing_reservations br
        JOIN ledger_entries le ON le.billing_reservation_id = br.id
          AND le.kind = 'settle' AND le.direction = 'debit'
        WHERE br.request_id = ul.request_id
      ) fh ON true`;
const usageWhere = (start: number, end: number): SQL =>
  sql`WHERE ul.created_at >= ${start} AND ul.created_at < ${end}`;

interface UsageAgg {
  requests: number;
  charged_vnd: string;
  upstream_cost_usd_micro: string;
  upstream_cost_vnd: string;
  upstream_missing_fx_usd_micro: string;
  margin_incomplete_requests: number;
  realized_gross_margin_vnd: string;
}

interface UsageAggRow extends UsageAgg {
  day?: string;
  public_model?: string;
  workspace_id?: string;
  workspace_name?: string;
}

export const adminBusinessRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-business" }).get(
    "/api/v1/admin/business",
    {
      query: t.Object({
        /** Inclusive UTC start date (YYYY-MM-DD, 00:00:00.000Z). */
        from: t.Optional(t.String()),
        /** Exclusive UTC end date (YYYY-MM-DD, 00:00:00.000Z next-day start). */
        to: t.Optional(t.String()),
      }),
      detail: {
        tags: ["Admin"],
        summary: "Business report: revenue, upstream cost, margin, cash",
        description:
          "Instance-admin only, read-only. Aggregates stored usage/financial snapshots over a bounded UTC date range (from inclusive, to exclusive; max 366 days; default last 30 days ending at tomorrow 00:00 UTC). Money aggregates are exact decimal strings.",
        security: [{ cookieAuth: [] }],
      },
    },
    async ({ request, query }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const denied = await requireInstanceAdmin(db, gate.session.user.id);
      if (denied) return denied;

      // Range: from inclusive, to exclusive (explicit, so `to` = day N covers
      // all of day N−1 and every day in between without time-of-day guessing).
      const toMs = query.to !== undefined ? parseUtcDate(query.to) : null;
      const fromMs = query.from !== undefined ? parseUtcDate(query.from) : null;
      if (query.to !== undefined && toMs === null)
        return jsonError(400, "INVALID", "to must be a real UTC date (YYYY-MM-DD)");
      if (query.from !== undefined && fromMs === null)
        return jsonError(400, "INVALID", "from must be a real UTC date (YYYY-MM-DD)");
      const now = new Date();
      const end =
        toMs ?? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS;
      const start = fromMs ?? end - DEFAULT_RANGE_DAYS * DAY_MS;
      const days = (end - start) / DAY_MS;
      if (!Number.isInteger(days) || days < 1 || days > MAX_RANGE_DAYS)
        return jsonError(
          400,
          "INVALID",
          `Date range must span 1..${MAX_RANGE_DAYS} whole UTC days (from inclusive, to exclusive)`,
        );

      const dayExpr = sql`to_char(to_timestamp(ul.created_at / 1000.0) at time zone 'UTC', 'YYYY-MM-DD')`;

      const [totals, daily, byModel, byWorkspace, payments, refunds, walletKinds, apu] =
        await Promise.all([
          rawRows<UsageAgg>(
            db,
            sql`SELECT ${aggregates} ${usageFrom(false)} ${usageWhere(start, end)}`,
          ),
          rawRows<UsageAggRow>(
            db,
            sql`SELECT ${dayExpr} AS day, ${aggregates} ${usageFrom(false)} ${usageWhere(start, end)} GROUP BY day ORDER BY day`,
          ),
          rawRows<UsageAggRow>(
            db,
            sql`SELECT ul.public_model, ${aggregates} ${usageFrom(false)} ${usageWhere(start, end)} GROUP BY ul.public_model ORDER BY sum(${chargedVndExpr}) DESC`,
          ),
          rawRows<UsageAggRow>(
            db,
            sql`SELECT ul.workspace_id, coalesce(w.name, ul.workspace_id) AS workspace_name, ${aggregates} ${usageFrom(true)} ${usageWhere(start, end)}
              GROUP BY ul.workspace_id, w.name
              ORDER BY sum(${chargedVndExpr}) DESC`,
          ),
          // Cash receipts bucketed by PAID day: payment_events.processed_at is
          // written in the same transaction that flips status to 'succeeded'
          // (webhook OR admin-complete path), so it is the durable paid-at
          // time — payments.created_at is the order-creation day and can
          // precede approval by days. Fallback to created_at only when an
          // event row is missing (counted in cash_receipts_fallback_rows so
          // the basis is never silently mixed).
          rawRows<{
            cash_receipts_vnd: string;
            cash_topups_vnd: string;
            bundle_sales_vnd: string;
            subscription_sales_vnd: string;
            cash_receipts_fallback_rows: number;
          }>(
            db,
            sql`SELECT
              coalesce(sum(p.amount), 0)::text AS cash_receipts_vnd,
              coalesce(sum(p.amount) FILTER (WHERE p.bundle_id IS NULL AND p.subscription_plan_id IS NULL), 0)::text AS cash_topups_vnd,
              coalesce(sum(p.amount) FILTER (WHERE p.bundle_id IS NOT NULL), 0)::text AS bundle_sales_vnd,
              coalesce(sum(p.amount) FILTER (WHERE p.subscription_plan_id IS NOT NULL), 0)::text AS subscription_sales_vnd,
              (count(*) FILTER (WHERE pe.paid_at IS NULL))::int AS cash_receipts_fallback_rows
            FROM payments p
            LEFT JOIN LATERAL (
              SELECT min(ev.processed_at) AS paid_at FROM payment_events ev WHERE ev.payment_id = p.id
            ) pe ON true
            WHERE p.status = 'succeeded'
              AND coalesce(pe.paid_at, p.created_at) >= ${start}
              AND coalesce(pe.paid_at, p.created_at) < ${end}`,
          ),
          rawRows<{ refund_vnd: string }>(
            db,
            sql`SELECT coalesce(sum(le.amount), 0)::text AS refund_vnd
            FROM ledger_entries le
            WHERE le.kind = 'refund' AND le.direction = 'credit'
              AND le.created_at >= ${start} AND le.created_at < ${end}`,
          ),
          // Snapshot (not range-bounded): outstanding prepaid credit is the
          // liability owed RIGHT NOW — cash received but not yet consumed.
          rawRows<{ prepaid_liability_vnd: string; subscription_credit_vnd: string }>(
            db,
            sql`SELECT
              coalesce(sum(balance) FILTER (WHERE kind = 'topup'), 0)::text AS prepaid_liability_vnd,
              coalesce(sum(balance) FILTER (WHERE kind = 'subscription'), 0)::text AS subscription_credit_vnd
            FROM wallets`,
          ),
          // Active paying users: distinct users who are members of a workspace
          // that both consumed usage in the range AND has a succeeded payment
          // in the range (real joins; COUNT DISTINCT is fanout-proof).
          rawRows<{ n: number }>(
            db,
            sql`SELECT count(DISTINCT wm.user_id)::int AS n
            FROM usage_logs ul
            JOIN workspace_members wm ON wm.workspace_id = ul.workspace_id
            WHERE ul.created_at >= ${start} AND ul.created_at < ${end}
              AND EXISTS (
                SELECT 1 FROM payments p
                LEFT JOIN LATERAL (
                  SELECT min(ev.processed_at) AS paid_at FROM payment_events ev WHERE ev.payment_id = p.id
                ) pe ON true
                WHERE p.workspace_id = ul.workspace_id
                  AND p.status = 'succeeded'
                  AND coalesce(pe.paid_at, p.created_at) >= ${start}
                  AND coalesce(pe.paid_at, p.created_at) < ${end}
              )`,
          ),
        ]);

      return json({
        range: {
          from: new Date(start).toISOString().slice(0, 10),
          to: new Date(end).toISOString().slice(0, 10),
          from_ms: start,
          to_ms: end,
          days,
        },
        totals: {
          requests: totals[0]?.requests ?? 0,
          charged_vnd: totals[0]?.charged_vnd ?? "0",
          upstream_cost_usd_micro: totals[0]?.upstream_cost_usd_micro ?? "0",
          upstream_cost_vnd: totals[0]?.upstream_cost_vnd ?? "0",
          upstream_missing_fx_usd_micro: totals[0]?.upstream_missing_fx_usd_micro ?? "0",
          upstream_missing_cost_requests: totals[0]?.margin_incomplete_requests ?? 0,
          realized_gross_margin_vnd: totals[0]?.realized_gross_margin_vnd ?? "0",
          margin_provisional: (totals[0]?.margin_incomplete_requests ?? 0) > 0,
          refund_vnd: refunds[0]?.refund_vnd ?? "0",
          cash_receipts_vnd: payments[0]?.cash_receipts_vnd ?? "0",
          cash_topups_vnd: payments[0]?.cash_topups_vnd ?? "0",
          bundle_sales_vnd: payments[0]?.bundle_sales_vnd ?? "0",
          subscription_sales_vnd: payments[0]?.subscription_sales_vnd ?? "0",
          cash_receipts_fallback_rows: payments[0]?.cash_receipts_fallback_rows ?? 0,
          prepaid_liability_vnd: walletKinds[0]?.prepaid_liability_vnd ?? "0",
          subscription_credit_vnd: walletKinds[0]?.subscription_credit_vnd ?? "0",
        },
        active_paying_users: apu[0]?.n ?? 0,
        // Each breakdown row carries margin_provisional so the UI can flag
        // buckets whose margin is incomplete instead of presenting it as exact.
        daily: daily.map((r) => ({ ...r, margin_provisional: r.margin_incomplete_requests > 0 })),
        by_model: byModel.map((r) => ({
          ...r,
          margin_provisional: r.margin_incomplete_requests > 0,
        })),
        by_workspace: byWorkspace.map((r) => ({
          ...r,
          margin_provisional: r.margin_incomplete_requests > 0,
        })),
      });
    },
  );
