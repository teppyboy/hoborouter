// Admin business report: GET /api/v1/admin/business (route not yet registered
// in the real app — this test wires it locally against a real migrated test DB).
// Covers: admin-only authz (401/403), date validation (400), inclusive-from /
// exclusive-to UTC boundaries, aggregation correctness over seeded multi-FX
// multi-markup rows (stored charged_vnd + per-row historical FX — never a
// current rate), soft-hidden logs staying in financial totals, missing-cost /
// missing-FX rows flagging margin as provisional, cash receipts from SUCCEEDED
// payments by PAID day (payment_events.processed_at) with promo/adjustment
// ledger credits excluded, refund reported separately, no join fanout.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { adminBusinessRoutes } from "../src/routes/admin-business";
import { makeApp, signUp, addMember, makeInstanceAdmin, userIdByEmail } from "./helpers";

const ADMIN = "biz-admin@example.com";
const U1 = "biz-u1@example.com";
const U2 = "biz-u2@example.com";
const U3 = "biz-u3@example.com";

// UTC date range under test: 2026-02-01 (inclusive) .. 2026-02-05 (exclusive).
const FROM = "2026-02-01";
const TO = "2026-02-05";
const FROM_MS = Date.UTC(2026, 1, 1);
const TO_MS = Date.UTC(2026, 1, 5);
const D1 = FROM_MS + 3_600_000;
const D2 = Date.UTC(2026, 1, 2) + 3_600_000;
const D3 = Date.UTC(2026, 1, 3) + 3_600_000;
const OLD = Date.UTC(2026, 0, 20);

let ctx: Awaited<ReturnType<typeof makeApp>>;
let db: Db;
let admin: string;
let member: string;
// Structural type only — Elysia's chained generics make exact inference brittle.
let localApp: { handle: (req: Request) => Promise<Response> };

interface Report {
  range: { from: string; to: string; from_ms: number; to_ms: number; days: number };
  totals: Record<string, number | string | boolean>;
  active_paying_users: number;
  daily: Array<Record<string, unknown>>;
  by_model: Array<Record<string, unknown>>;
  by_workspace: Array<Record<string, unknown>>;
}

const get = (path: string, cookie?: string) =>
  localApp.handle(new Request("http://localhost" + path, { headers: cookie ? { cookie } : {} }));

const report = async (
  query = `?from=${FROM}&to=${TO}`,
): Promise<{ status: number; body: Report }> => {
  const res = await get(`/api/v1/admin/business${query}`, admin);
  return { status: res.status, body: (await res.json()) as Report };
};

beforeAll(async () => {
  ctx = await makeApp();
  db = ctx.db;
  admin = await signUp(ctx.app, ADMIN);
  await signUp(ctx.app, U1);
  await signUp(ctx.app, U2);
  await signUp(ctx.app, U3);
  member = await signUp(ctx.app, "biz-member@example.com");
  await makeInstanceAdmin(db, await userIdByEmail(db, ADMIN));
  // workspace_members FK requires the workspace rows to exist first.
  const now = Date.now();
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at)
        VALUES ('ws-biz-a', 'ws-biz-a', 'active', ${now}),
               ('ws-biz-b', 'ws-biz-b', 'active', ${now})`,
  );
  await addMember(db, "ws-biz-a", await userIdByEmail(db, U1), "owner");
  await addMember(db, "ws-biz-a", await userIdByEmail(db, U2), "member");
  await addMember(db, "ws-biz-b", await userIdByEmail(db, U3), "owner");

  // Local app: auth endpoints + the route under test (app.ts registration is a
  // separate integration step owned elsewhere).
  localApp = new Elysia()
    .get("/api/auth/*", (c) => ctx.auth.handler(c.request))
    .all("/api/auth/*", (c) => ctx.auth.handler(c.request))
    .use(adminBusinessRoutes(db, ctx.auth));

  await db.execute(
    sql`INSERT INTO models (id, public_id, slug, display_name, provider, created_at, updated_at)
        VALUES ('mod-a', 'model-a', 'model-a', 'A', 'openai', ${D1}, ${D1}),
               ('mod-b', 'model-b', 'model-b', 'B', 'openai', ${D1}, ${D1})`,
  );
  await db.execute(
    sql`INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m,
          cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at)
        VALUES ('price-hold', 'mod-a', 1, 1, 1, 1, 100000, ${D1})`,
  );

  const seedUsage = async (o: {
    id: string;
    ws: string;
    model: string;
    ts: number;
    cost: number | null;
    rate: number | null;
    charged: number | null;
    status?: string;
    deleted?: boolean;
  }) => {
    await db.execute(
      sql`INSERT INTO requests (id, workspace_id, endpoint, mode, status, created_at, model_id, deleted_at)
          VALUES (${o.id}, ${o.ws}, '/v1/chat/completions', 'stream', 'ok', ${o.ts}, ${o.model === "model-c" ? "mod-a" : o.model === "model-a" ? "mod-a" : "mod-b"}, ${o.deleted ? o.ts : null})`,
    );
    await db.execute(
      sql`INSERT INTO usage_logs (id, idempotency_key, request_id, workspace_id, provider, public_model,
            upstream_model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, status,
            upstream_cost_usd_micro, usd_vnd_exchange_rate, markup_ppm, charged_vnd, created_at)
          VALUES (${"ul-" + o.id}, ${"idem-" + o.id}, ${o.id}, ${o.ws}, 'openai', ${o.model}, 'up-x', 10, 20, 0, 0, ${o.status ?? "ok"},
            ${o.cost}, ${o.rate}, ${o.cost !== null && o.rate !== null ? 100000 : null}, ${o.charged}, ${o.ts})`,
    );
  };

  // Day 1, ws-a. Stored snapshots are seeded verbatim — the report must sum
  // them, never recompute from catalog prices.
  await seedUsage({
    id: "r-d1a",
    ws: "ws-biz-a",
    model: "model-a",
    ts: D1,
    cost: 1_000_000,
    rate: 25_000,
    charged: 27_500,
  });
  await seedUsage({
    id: "r-d1b",
    ws: "ws-biz-a",
    model: "model-b",
    ts: D1,
    cost: 500_000,
    rate: 26_000,
    charged: 14_300,
  });
  // Soft-deleted request: usage stays in financial totals.
  await seedUsage({
    id: "r-del",
    ws: "ws-biz-a",
    model: "model-a",
    ts: D1,
    cost: 123_456,
    rate: 25_000,
    charged: 3_000,
    deleted: true,
  });
  // full-hold row: no charge, no cost — counts as a request, moves no money.
  await seedUsage({
    id: "r-hold",
    ws: "ws-biz-a",
    model: "model-a",
    ts: D1,
    cost: null,
    rate: null,
    charged: null,
    status: "full_hold",
  });
  // Cost present but FX rate missing: margin row is provisional, cost not silently converted.
  await seedUsage({
    id: "r-nofx",
    ws: "ws-biz-a",
    model: "model-c",
    ts: D1,
    cost: 100_000,
    rate: null,
    charged: 5_000,
  });
  // Day 2, ws-b.
  await seedUsage({
    id: "r-d2",
    ws: "ws-biz-b",
    model: "model-a",
    ts: D2,
    cost: 2_500_000,
    rate: 25_000,
    charged: 68_750,
  });
  // Day 3, ws-a: same model, DIFFERENT stored FX — per-row historical conversion.
  await seedUsage({
    id: "r-d3",
    ws: "ws-biz-a",
    model: "model-a",
    ts: D3,
    cost: 1_000_000,
    rate: 30_000,
    charged: 31_000,
  });
  // Outside the range: before `from`, and exactly at `to` (exclusive).
  await seedUsage({
    id: "r-old",
    ws: "ws-biz-a",
    model: "model-a",
    ts: OLD,
    cost: 999_999,
    rate: 25_000,
    charged: 25_000,
  });
  await seedUsage({
    id: "r-edge",
    ws: "ws-biz-a",
    model: "model-a",
    ts: TO_MS,
    cost: 10_000,
    rate: 25_000,
    charged: 300,
  });

  await db.execute(
    sql`INSERT INTO wallets (id, workspace_id, kind, balance, reserved, created_at)
        VALUES ('wal-a', 'ws-biz-a', 'topup', 40000, 0, ${D1}),
               ('wal-a-sub', 'ws-biz-a', 'subscription', 8000, 0, ${D1}),
               ('wal-b', 'ws-biz-b', 'topup', 25000, 0, ${D1})`,
  );
  // Production full-hold path leaves usage_logs.charged_vnd NULL. The actual
  // cap debit is the settle ledger row linked through its billing reservation.
  await db.execute(
    sql`INSERT INTO billing_reservations
          (id, wallet_id, request_id, model_id, model_price_id, usd_vnd_exchange_rate,
           markup_ppm, cap_vnd, status, created_at, resolved_at)
        VALUES ('br-hold', 'wal-a', 'r-hold', 'mod-a', 'price-hold', 25000,
                100000, 9000, 'settled_full_hold', ${D1}, ${D1})`,
  );
  // Ledger: settle debit + refund credit (needs original) + a promo adjustment.
  // Receipts must come from payments, never from these credits.
  await db.execute(
    sql`INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, memo, created_at)
        VALUES ('led-settle-1', 'wal-a', 'debit', 2500, 'settle', 37500, 'seed', ${D1})`,
  );
  await db.execute(
    sql`INSERT INTO ledger_entries
          (id, wallet_id, direction, billing_reservation_id, amount, kind, balance_after, memo, created_at)
        VALUES ('led-hold-settle', 'wal-a', 'debit', 'br-hold', 9000, 'settle', 28500, 'full hold', ${D1})`,
  );
  // Refund must carry its original settle id at insert time (ledger_refund_requires_original).
  await db.execute(
    sql`INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, memo, created_at, original_ledger_entry_id)
        VALUES ('led-refund-1', 'wal-a', 'credit', 2500, 'refund', 40000, 'seed', ${D1 + 1}, 'led-settle-1')`,
  );
  await db.execute(
    sql`INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, memo, created_at)
        VALUES ('led-adj-1', 'wal-a', 'credit', 10000, 'adjustment', 50000, 'promo seed', ${D1 + 1})`,
  );

  await db.execute(
    sql`INSERT INTO credit_bundles (id, name, price_vnd, credit_vnd, bonus_vnd, created_at)
        VALUES ('cb-1', 'Seed bundle', 100000, 120000, 0, ${D1})`,
  );
  await db.execute(
    sql`INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, created_at)
        VALUES ('sp-1', 'Seed plan', 200000, 180000, ${D1})`,
  );

  const seedPayment = async (o: {
    id: string;
    ws: string;
    amount: number;
    status: string;
    created: number;
    bundle?: string;
    plan?: string;
    paidAt?: number | null;
  }) => {
    await db.execute(
      sql`INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at, bundle_id, subscription_plan_id)
          VALUES (${o.id}, ${o.ws}, ${o.amount}, ${o.status}, 'mock', ${"ORD-" + o.id}, ${o.created}, ${o.bundle ?? null}, ${o.plan ?? null})`,
    );
    if (o.paidAt != null) {
      await db.execute(
        sql`INSERT INTO payment_events (id, payment_id, provider, provider_reference, processed_at)
            VALUES (${"ev-" + o.id}, ${o.id}, 'mock', ${"ref-" + o.id}, ${o.paidAt})`,
      );
    }
  };

  // Paid day differs from created day: created Feb 1, PAID Feb 3.
  await seedPayment({
    id: "p-top",
    ws: "ws-biz-a",
    amount: 50000,
    status: "succeeded",
    created: D1,
    paidAt: Date.UTC(2026, 1, 3) + 7_200_000,
  });
  await seedPayment({
    id: "p-bundle",
    ws: "ws-biz-b",
    amount: 100000,
    status: "succeeded",
    created: D2,
    bundle: "cb-1",
    paidAt: D2,
  });
  await seedPayment({
    id: "p-sub",
    ws: "ws-biz-a",
    amount: 200000,
    status: "succeeded",
    created: D3,
    plan: "sp-1",
    paidAt: Date.UTC(2026, 1, 4),
  });
  await seedPayment({
    id: "p-pending",
    ws: "ws-biz-a",
    amount: 99000,
    status: "pending",
    created: D1,
  });
  await seedPayment({
    id: "p-old",
    ws: "ws-biz-a",
    amount: 70000,
    status: "succeeded",
    created: OLD,
    paidAt: OLD,
  });
  // Paid exactly at `to` — exclusive boundary, excluded.
  await seedPayment({
    id: "p-edge",
    ws: "ws-biz-a",
    amount: 300,
    status: "succeeded",
    created: TO_MS,
    paidAt: TO_MS,
  });
});

describe("GET /api/v1/admin/business — authz", () => {
  test("unauthenticated -> 401", async () => {
    const res = await get("/api/v1/admin/business");
    expect(res.status).toBe(401);
  });

  test("non-admin session -> 403", async () => {
    const res = await get("/api/v1/admin/business", member);
    expect(res.status).toBe(403);
  });

  test("instance admin -> 200", async () => {
    const { status } = await report();
    expect(status).toBe(200);
  });
});

describe("GET /api/v1/admin/business — date validation", () => {
  test.each([
    ["bad format", "from=2025-1-1"],
    ["impossible date", "from=2026-02-30"],
    ["from equals to", "from=2026-02-05&to=2026-02-05"],
    ["from after to", "from=2026-02-05&to=2026-02-01"],
    ["beyond 366 days", "from=2025-01-01&to=2026-02-05"],
  ])("%s -> 400", async (_name, query) => {
    const { status } = await report(`?${query}`);
    expect(status).toBe(400);
  });

  test("default range is 30 days ending at tomorrow 00:00 UTC", async () => {
    const { body } = await report("");
    expect(body.range.days).toBe(30);
    const now = new Date();
    const tomorrowUtc =
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 86_400_000;
    expect(body.range.to_ms).toBe(tomorrowUtc);
    expect(body.range.from_ms).toBe(tomorrowUtc - 30 * 86_400_000);
  });
});

describe("GET /api/v1/admin/business — aggregation", () => {
  test("totals: stored charged VND, per-row historical FX cost, provisional margin, receipts by paid day", async () => {
    const { body } = await report();
    expect(body.range).toEqual({ from: FROM, to: TO, from_ms: FROM_MS, to_ms: TO_MS, days: 4 });
    const t = body.totals;
    // 7 usage rows in range (soft-deleted + full-hold included; old + edge excluded).
    expect(t.requests).toBe(7);
    expect(t.charged_vnd).toBe("158550");
    expect(t.upstream_cost_usd_micro).toBe("5223456");
    // 25000 (25k micro @25000) + 13000 (500k @26000) + 3087 (123456 @25000, ceil)
    // + 62500 (2.5m @25000) + 30000 (1m @30000) — per-row stored FX, never one rate.
    expect(t.upstream_cost_vnd).toBe("133587");
    // Missing-FX cost reported raw, never converted at today's rate.
    expect(t.upstream_missing_fx_usd_micro).toBe("100000");
    // One charged row (model-c) has no usable cost basis -> margin provisional.
    expect(t.upstream_missing_cost_requests).toBe(2);
    expect(t.margin_provisional).toBe(true);
    expect(t.realized_gross_margin_vnd).toBe("24963");
    // Cash receipts: SUCCEEDED payments by PAID day (payment_events.processed_at).
    // Pending 99000, old 70000, boundary 300 excluded; paid day != created day
    // is bucketed by the event time.
    expect(t.cash_receipts_vnd).toBe("350000");
    expect(t.cash_topups_vnd).toBe("50000");
    expect(t.bundle_sales_vnd).toBe("100000");
    expect(t.subscription_sales_vnd).toBe("200000");
    expect(t.cash_receipts_fallback_rows).toBe(0);
    // Ledger credits (promo adjustment 10000) never inflate receipts.
    // Refunds reported separately, never netted into usage revenue.
    expect(t.refund_vnd).toBe("2500");
    // Wallet snapshot liabilities.
    expect(t.prepaid_liability_vnd).toBe("65000");
    expect(t.subscription_credit_vnd).toBe("8000");
    // ws-a (u1+u2) + ws-b (u3): usage in range + succeeded payment in range.
    expect(body.active_paying_users).toBe(3);
    // Money aggregates are exact decimal strings, not floats.
    expect(typeof t.charged_vnd).toBe("string");
  });

  test("daily buckets by UTC day with per-bucket provisional flags", async () => {
    const { body } = await report();
    expect(body.daily).toEqual([
      {
        day: "2026-02-01",
        requests: 5,
        charged_vnd: "58800",
        upstream_cost_usd_micro: "1723456",
        upstream_cost_vnd: "41087",
        upstream_missing_fx_usd_micro: "100000",
        margin_incomplete_requests: 2,
        realized_gross_margin_vnd: "17713",
        margin_provisional: true,
      },
      {
        day: "2026-02-02",
        requests: 1,
        charged_vnd: "68750",
        upstream_cost_usd_micro: "2500000",
        upstream_cost_vnd: "62500",
        upstream_missing_fx_usd_micro: "0",
        margin_incomplete_requests: 0,
        realized_gross_margin_vnd: "6250",
        margin_provisional: false,
      },
      {
        day: "2026-02-03",
        requests: 1,
        charged_vnd: "31000",
        upstream_cost_usd_micro: "1000000",
        upstream_cost_vnd: "30000",
        upstream_missing_fx_usd_micro: "0",
        margin_incomplete_requests: 0,
        realized_gross_margin_vnd: "1000",
        margin_provisional: false,
      },
    ]);
  });

  test("by_model uses the public model and per-row FX across days", async () => {
    const { body } = await report();
    expect(body.by_model).toEqual([
      {
        public_model: "model-a",
        requests: 5,
        charged_vnd: "139250",
        upstream_cost_usd_micro: "4623456",
        upstream_cost_vnd: "120587",
        upstream_missing_fx_usd_micro: "0",
        margin_incomplete_requests: 1,
        realized_gross_margin_vnd: "18663",
        margin_provisional: true,
      },
      {
        public_model: "model-b",
        requests: 1,
        charged_vnd: "14300",
        upstream_cost_usd_micro: "500000",
        upstream_cost_vnd: "13000",
        upstream_missing_fx_usd_micro: "0",
        margin_incomplete_requests: 0,
        realized_gross_margin_vnd: "1300",
        margin_provisional: false,
      },
      {
        public_model: "model-c",
        requests: 1,
        charged_vnd: "5000",
        upstream_cost_usd_micro: "100000",
        upstream_cost_vnd: "0",
        upstream_missing_fx_usd_micro: "100000",
        margin_incomplete_requests: 1,
        realized_gross_margin_vnd: "5000",
        margin_provisional: true,
      },
    ]);
  });

  test("by_workspace: no join fanout — counts stay per-row (5+1+1), names resolved", async () => {
    const { body } = await report();
    expect(body.by_workspace).toEqual([
      {
        workspace_id: "ws-biz-a",
        workspace_name: "ws-biz-a",
        requests: 6,
        charged_vnd: "89800",
        upstream_cost_usd_micro: "2723456",
        upstream_cost_vnd: "71087",
        upstream_missing_fx_usd_micro: "100000",
        margin_incomplete_requests: 2,
        realized_gross_margin_vnd: "18713",
        margin_provisional: true,
      },
      {
        workspace_id: "ws-biz-b",
        workspace_name: "ws-biz-b",
        requests: 1,
        charged_vnd: "68750",
        upstream_cost_usd_micro: "2500000",
        upstream_cost_vnd: "62500",
        upstream_missing_fx_usd_micro: "0",
        margin_incomplete_requests: 0,
        realized_gross_margin_vnd: "6250",
        margin_provisional: false,
      },
    ]);
  });
});
