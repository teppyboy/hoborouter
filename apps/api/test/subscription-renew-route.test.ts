// Renew (resume) route — the DELETE counterpart: member-only PUT that clears
// the canceled_at marker so the canceled subscription re-enters the normal
// renewal path. Moves NO money (no refund, no credit, no new charge), leaves
// the current period untouched, 404s for non-members/unknown workspaces (no
// existence leak) and when there is no active subscription, and repeats are
// idempotent (one audit row).
import { describe, test, expect, beforeAll } from "bun:test";
import { q, makeApp, signUp, req, createWorkspace, userIdByEmail } from "./helpers";
import { createAuth } from "../src/auth";
import { subscriptionCancelRoutes } from "../src/routes/subscription-cancel";
import type { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof makeApp>>["db"];
// The renew route lives in the same Elysia instance as cancel; tests mount
// the handler standalone so the route file is testable in isolation.
let renewApp: ReturnType<typeof subscriptionCancelRoutes>;
let renewTarget: Awaited<ReturnType<typeof buildApp>>;
let memberCookie: string;
let outsiderCookie: string;
let ws: string;

const NOW = Date.now();
const DAY_MS = 86_400_000;

async function seedCanceledSubscription(): Promise<void> {
  await q(
    db,
    `INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, active, created_at)
     VALUES ('plan-renew-route', 'Plan', 200000, 250000, 30, true, ?)`,
    NOW,
  );
  await q(
    db,
    `INSERT INTO wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at)
     VALUES ('wal-sub-renew-route', ?, 'subscription', 'VND', 250000, 0, 0, ?)`,
    ws,
    NOW,
  );
  await q(
    db,
    `INSERT INTO subscriptions (id, workspace_id, plan_id, status, canceled_at, current_period_start, current_period_end, created_at)
     VALUES ('sub-renew-route', ?, 'plan-renew-route', 'active', ?, ?, ?, ?)`,
    ws,
    NOW - 3_600_000,
    NOW - DAY_MS,
    NOW + 30 * DAY_MS,
    NOW - DAY_MS,
  );
}

beforeAll(async () => {
  ({ db, app } = await makeApp());
  const auth = createAuth(db);
  renewApp = subscriptionCancelRoutes(db, auth);
  renewTarget = renewApp as unknown as Awaited<ReturnType<typeof buildApp>>;
  memberCookie = await signUp(app, "subrenew-member@test.dev", "M");
  outsiderCookie = await signUp(app, "subrenew-out@test.dev", "O");
  ws = "ws-subrenew";
  await createWorkspace(db, ws, await userIdByEmail(db, "subrenew-member@test.dev"));
});

describe("PUT /api/v1/workspaces/:id/subscription", () => {
  test("unauthenticated 401; outsider and unknown workspace 404 (masked)", async () => {
    const res = await req(renewTarget, `/api/v1/workspaces/${ws}/subscription`, {
      method: "PUT",
    });
    expect(res.status).toBe(401);
    const out = await req(renewTarget, `/api/v1/workspaces/${ws}/subscription`, {
      method: "PUT",
      cookie: outsiderCookie,
    });
    expect(out.status).toBe(404);
    const unknown = await req(renewTarget, "/api/v1/workspaces/ws-missing/subscription", {
      method: "PUT",
      cookie: memberCookie,
    });
    expect(unknown.status).toBe(404);
  });

  test("member renew: 200, cancel marker cleared, no wallet/ledger movement", async () => {
    await seedCanceledSubscription();
    const res = await req(renewTarget, `/api/v1/workspaces/${ws}/subscription`, {
      method: "PUT",
      cookie: memberCookie,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      status: string;
      canceled: boolean;
      period_end: number;
    };
    expect(body.id).toBe("sub-renew-route");
    expect(body.status).toBe("active");
    expect(body.canceled).toBe(false);
    expect(body.period_end).toBe(NOW + 30 * DAY_MS);
    const rows = await q<{ status: string; canceled_at: string | null }>(
      db,
      "SELECT status, canceled_at FROM subscriptions WHERE id = 'sub-renew-route'",
    );
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.canceled_at).toBeNull();
    // No money moved: subscription wallet untouched, no new ledger entries.
    const ledger = await q(
      db,
      `SELECT * FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id
       WHERE w.workspace_id = ? AND w.kind = 'subscription'`,
      ws,
    );
    expect(ledger.length).toBe(0);
    const audits = await q<{ n: string }>(
      db,
      "SELECT count(*) AS n FROM audit_log WHERE action = 'subscription.renew' AND workspace_id = ?",
      ws,
    );
    expect(Number(audits[0]!.n)).toBe(1);
  });

  test("renew does not change the period: no new charge boundary", async () => {
    const rows = await q<{ current_period_start: string; current_period_end: string }>(
      db,
      "SELECT current_period_start, current_period_end FROM subscriptions WHERE id = 'sub-renew-route'",
    );
    expect(Number(rows[0]!.current_period_start)).toBe(NOW - DAY_MS);
    expect(Number(rows[0]!.current_period_end)).toBe(NOW + 30 * DAY_MS);
  });

  test("wallet GET reports canceled: false after renew", async () => {
    const res = await req(app, `/api/v1/workspaces/${ws}/wallet`, { cookie: memberCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscription: { expired: boolean; canceled: boolean; balance: number } | null;
    };
    expect(body.subscription).not.toBeNull();
    expect(body.subscription!.expired).toBe(false);
    expect(body.subscription!.canceled).toBe(false);
    expect(body.subscription!.balance).toBe(250000);
  });

  test("renew is idempotent: repeat 200, still one audit row", async () => {
    const res = await req(renewTarget, `/api/v1/workspaces/${ws}/subscription`, {
      method: "PUT",
      cookie: memberCookie,
    });
    expect(res.status).toBe(200);
    const audits = await q<{ n: string }>(
      db,
      "SELECT count(*) AS n FROM audit_log WHERE action = 'subscription.renew' AND workspace_id = ?",
      ws,
    );
    expect(Number(audits[0]!.n)).toBe(1);
  });

  test("no active subscription: 404", async () => {
    const other = "ws-subrenew-empty";
    await createWorkspace(db, other, await userIdByEmail(db, "subrenew-member@test.dev"));
    const res = await req(renewTarget, `/api/v1/workspaces/${other}/subscription`, {
      method: "PUT",
      cookie: memberCookie,
    });
    expect(res.status).toBe(404);
  });
});
