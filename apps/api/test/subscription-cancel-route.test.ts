// Cancel-subscription route (decision b): member-only DELETE that marks the
// active subscription canceled (stops renewal) WITHOUT touching money —
// status stays 'active', credit stays spendable through period_end, and the
// wallet GET payload gains the additive `canceled` flag. Non-members and
// unknown workspaces both 404 (no workspace existence leak), 404 when there
// is nothing to cancel, and repeats stay idempotent.
import { describe, test, expect, beforeAll } from "bun:test";
import { q, makeApp, signUp, req, createWorkspace, userIdByEmail } from "./helpers";
import { createAuth } from "../src/auth";
import { subscriptionCancelRoutes } from "../src/routes/subscription-cancel";
import type { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof makeApp>>["db"];
// The cancel route is registered in apps/api/src/app.ts by the parent commit;
// tests mount the handler standalone so the route file is testable now.
let cancelApp: ReturnType<typeof subscriptionCancelRoutes>;
// req() is typed against buildApp; the standalone mount has the same handle()
// surface, so tests cast once (assigned in beforeAll).
let cancelTarget: Awaited<ReturnType<typeof buildApp>>;
let memberCookie: string;
let outsiderCookie: string;
let ws: string;

const NOW = Date.now();
const DAY_MS = 86_400_000;

async function seedSubscription(): Promise<void> {
  await q(
    db,
    `INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, active, created_at)
     VALUES ('plan-cancel-route', 'Plan', 200000, 250000, 30, true, ?)`,
    NOW,
  );
  await q(
    db,
    `INSERT INTO wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at)
     VALUES ('wal-sub-cancel-route', ?, 'subscription', 'VND', 250000, 0, 0, ?)`,
    ws,
    NOW,
  );
  await q(
    db,
    `INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
     VALUES ('sub-cancel-route', ?, 'plan-cancel-route', 'active', ?, ?, ?)`,
    ws,
    NOW - DAY_MS,
    NOW + 30 * DAY_MS,
    NOW - DAY_MS,
  );
}

beforeAll(async () => {
  ({ db, app } = await makeApp());
  const auth = createAuth(db);
  cancelApp = subscriptionCancelRoutes(db, auth);
  cancelTarget = cancelApp as unknown as Awaited<ReturnType<typeof buildApp>>;
  memberCookie = await signUp(app, "subcancel-member@test.dev", "M");
  outsiderCookie = await signUp(app, "subcancel-out@test.dev", "O");
  ws = "ws-subcancel";
  await createWorkspace(db, ws, await userIdByEmail(db, "subcancel-member@test.dev"));
});

describe("DELETE /api/v1/workspaces/:id/subscription", () => {
  test("unauthenticated 401; outsider and unknown workspace 404 (masked)", async () => {
    const res = await req(cancelTarget, `/api/v1/workspaces/${ws}/subscription`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
    const out = await req(cancelTarget, `/api/v1/workspaces/${ws}/subscription`, {
      method: "DELETE",
      cookie: outsiderCookie,
    });
    expect(out.status).toBe(404);
    const unknown = await req(cancelTarget, "/api/v1/workspaces/ws-missing/subscription", {
      method: "DELETE",
      cookie: memberCookie,
    });
    expect(unknown.status).toBe(404);
  });

  test("member cancel: 200, status stays active, no wallet/ledger movement", async () => {
    await seedSubscription();
    const res = await req(cancelTarget, `/api/v1/workspaces/${ws}/subscription`, {
      method: "DELETE",
      cookie: memberCookie,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      status: string;
      canceled_at: number;
      period_end: number;
    };
    expect(body.id).toBe("sub-cancel-route");
    expect(body.status).toBe("active");
    expect(body.period_end).toBe(NOW + 30 * DAY_MS);
    const rows = await q<{ status: string; canceled_at: string }>(
      db,
      "SELECT status, canceled_at FROM subscriptions WHERE id = 'sub-cancel-route'",
    );
    expect(rows[0]!.status).toBe("active");
    expect(Number(rows[0]!.canceled_at)).toBeGreaterThan(0);
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
      "SELECT count(*) AS n FROM audit_log WHERE action = 'subscription.cancel' AND workspace_id = ?",
      ws,
    );
    expect(Number(audits[0]!.n)).toBe(1);
  });

  test("wallet GET reports canceled: true additively; expired flag unchanged", async () => {
    const res = await req(app, `/api/v1/workspaces/${ws}/wallet`, { cookie: memberCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscription: { expired: boolean; canceled: boolean; balance: number } | null;
    };
    expect(body.subscription).not.toBeNull();
    expect(body.subscription!.expired).toBe(false);
    expect(body.subscription!.canceled).toBe(true);
    expect(body.subscription!.balance).toBe(250000);
  });

  test("cancel is idempotent: repeat 200, still one audit row", async () => {
    const res = await req(cancelTarget, `/api/v1/workspaces/${ws}/subscription`, {
      method: "DELETE",
      cookie: memberCookie,
    });
    expect(res.status).toBe(200);
    const audits = await q<{ n: string }>(
      db,
      "SELECT count(*) AS n FROM audit_log WHERE action = 'subscription.cancel' AND workspace_id = ?",
      ws,
    );
    expect(Number(audits[0]!.n)).toBe(1);
  });

  test("no active subscription: 404", async () => {
    const other = "ws-subcancel-empty";
    await createWorkspace(db, other, await userIdByEmail(db, "subcancel-member@test.dev"));
    const res = await req(cancelTarget, `/api/v1/workspaces/${other}/subscription`, {
      method: "DELETE",
      cookie: memberCookie,
    });
    expect(res.status).toBe(404);
  });
});
