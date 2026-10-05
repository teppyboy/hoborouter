// Member subscription surface: plan purchase route (pending payment carries
// subscription_plan_id at the server-side price; manual + payos like bundles,
// inactive plan 409, non-member 404) and the wallet GET subscription shape
// (null without a subscription; balance/available/period_end/plan_name/
// rate_limit_per_minute/expired with one). Money invariant: creating the
// purchase never moves any wallet; credit lands only on admin completion
// (same settlement code as the PayOS webhook) and only on the SUBSCRIPTION
// wallet.
import { describe, test, expect, beforeAll } from "bun:test";
import {
  q,
  makeApp,
  signUp,
  req,
  createWorkspace,
  userIdByEmail,
  makeInstanceAdmin,
} from "./helpers";
import type { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let adminCookie: string;
let memberCookie: string;
let outsiderCookie: string;
let ws: string;

const createPlan = async (over: Record<string, unknown> = {}) => {
  const res = await req(app, "/api/v1/admin/subscription-plans", {
    method: "POST",
    cookie: adminCookie,
    body: {
      name: "Plan",
      price_vnd: 200000,
      credit_per_period_vnd: 250000,
      ...over,
    },
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  ({ db, app } = await makeApp());
  adminCookie = await signUp(app, "submember-admin@test.dev", "A");
  await makeInstanceAdmin(db, await userIdByEmail(db, "submember-admin@test.dev"));
  memberCookie = await signUp(app, "submember-member@test.dev", "M");
  outsiderCookie = await signUp(app, "submember-out@test.dev", "O");
  ws = "ws-submember";
  await createWorkspace(db, ws, await userIdByEmail(db, "submember-member@test.dev"));
  await q(
    db,
    "INSERT INTO wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at) VALUES (?,?, 'topup', 'VND', 50000, 0, 0, ?)",
    `wal-${ws}`,
    ws,
    Date.now(),
  );
});

describe("plan purchase route", () => {
  test("manual purchase creates pending payment with plan id at server price", async () => {
    const plan = (await createPlan({ name: "Buyable" })).body;
    const res = await req(app, `/api/v1/workspaces/${ws}/subscription-plans/${plan.id}/purchase`, {
      method: "POST",
      cookie: memberCookie,
      body: { provider: "manual" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      amount: number;
      status: string;
      provider: string;
      provider_order_code: string;
    };
    expect(body.amount).toBe(200000); // server-side price, never client-supplied
    expect(body.status).toBe("pending");
    expect(body.provider).toBe("manual");
    expect(body.provider_order_code.startsWith("MANUAL-")).toBe(true);
    const rows = await q<{
      subscription_plan_id: string;
      bundle_id: null;
      status: string;
      amount: number;
    }>(
      db,
      "SELECT subscription_plan_id, bundle_id, status, amount FROM payments WHERE id = ?",
      body.id,
    );
    expect(rows[0]!.subscription_plan_id).toBe(String(plan.id));
    expect(rows[0]!.bundle_id).toBeNull();
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.amount).toBe(200000);
    // Purchase created no wallet movement: topup still 50000, no ledger rows.
    const ledger = await q(
      db,
      "SELECT * FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id WHERE w.workspace_id = ?",
      ws,
    );
    expect(ledger.length).toBe(0);
  });

  test("inactive plan is rejected with 409", async () => {
    // Admin POST always creates active; deactivation is PATCH-only.
    const plan = (await createPlan({ name: "Off" })).body;
    const deact = await req(app, `/api/v1/admin/subscription-plans/${plan.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { active: false },
    });
    expect(deact.status).toBe(200);
    const res = await req(app, `/api/v1/workspaces/${ws}/subscription-plans/${plan.id}/purchase`, {
      method: "POST",
      cookie: memberCookie,
      body: { provider: "manual" },
    });
    expect(res.status).toBe(409);
  });

  test("unknown plan is 404 for a member", async () => {
    const res = await req(app, `/api/v1/workspaces/${ws}/subscription-plans/nope/purchase`, {
      method: "POST",
      cookie: memberCookie,
      body: { provider: "manual" },
    });
    expect(res.status).toBe(404);
  });

  test("non-member and outsider get 404 (workspace existence masked); unauthenticated 401", async () => {
    const plan = (await createPlan({ name: "Gated" })).body;
    const path = `/api/v1/workspaces/${ws}/subscription-plans/${plan.id}/purchase`;
    const outsider = await req(app, path, {
      method: "POST",
      cookie: outsiderCookie,
      body: { provider: "manual" },
    });
    expect(outsider.status).toBe(404);
    const anon = await req(app, path, { method: "POST", body: { provider: "manual" } });
    expect(anon.status).toBe(401);
  });
});

describe("wallet GET subscription shape", () => {
  let plan: Record<string, unknown>;
  let paymentId: string;

  beforeAll(async () => {
    plan = (await createPlan({ name: "Shape", rate_limit_per_minute: 42 })).body;
    const res = await req(app, `/api/v1/workspaces/${ws}/subscription-plans/${plan.id}/purchase`, {
      method: "POST",
      cookie: memberCookie,
      body: { provider: "manual" },
    });
    paymentId = ((await res.json()) as { id: string }).id;
  });

  test("without a subscription: subscription is null, existing fields intact", async () => {
    const res = await req(app, `/api/v1/workspaces/${ws}/wallet`, { cookie: memberCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.currency).toBe("VND");
    expect(body.balance).toBe(50000);
    expect(body.reserved).toBe(0);
    expect(body.available).toBe(50000);
    expect(typeof body.usd_vnd_rate).toBe("number");
    expect(body.subscription).toBeNull();
  });

  test("after admin completion: subscription credited on the subscription wallet only", async () => {
    const complete = await req(app, `/api/v1/admin/payments/${paymentId}/complete`, {
      method: "POST",
      cookie: adminCookie,
    });
    expect(complete.status).toBe(200);
    const topup = await q<{ balance: number }>(
      db,
      "SELECT balance FROM wallets WHERE workspace_id = ? AND kind = 'topup'",
      ws,
    );
    expect(topup[0]!.balance).toBe(70000); // untouched by the plan credit; +20000 first topup bonus (default-on, lands on the TOPUP wallet only)
    const subWallet = await q<{ balance: number; reserved: number }>(
      db,
      "SELECT balance, reserved FROM wallets WHERE workspace_id = ? AND kind = 'subscription'",
      ws,
    );
    expect(subWallet[0]!.balance).toBe(250000);
    expect(subWallet[0]!.reserved).toBe(0);
    const subs = await q<{ current_period_end: number; plan_id: string; status: string }>(
      db,
      "SELECT current_period_end, plan_id, status FROM subscriptions WHERE workspace_id = ?",
      ws,
    );
    expect(subs.length).toBe(1);
    expect(subs[0]!.status).toBe("active");
    expect(subs[0]!.plan_id).toBe(String(plan.id));
    const periodMs = 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(subs[0]!.current_period_end - (Date.now() + periodMs))).toBeLessThan(60_000);
    // Replay of the same admin completion stays idempotent: no double credit.
    await req(app, `/api/v1/admin/payments/${paymentId}/complete`, {
      method: "POST",
      cookie: adminCookie,
    });
    const after = await q<{ balance: number }>(
      db,
      "SELECT balance FROM wallets WHERE workspace_id = ? AND kind = 'subscription'",
      ws,
    );
    expect(after[0]!.balance).toBe(250000);
  });

  test("wallet GET shows the active subscription", async () => {
    const res = await req(app, `/api/v1/workspaces/${ws}/wallet`, { cookie: memberCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscription: {
        balance: number;
        available: number;
        period_end: number;
        plan_name: string;
        rate_limit_per_minute: number;
        expired: boolean;
      } | null;
    };
    expect(body.subscription).not.toBeNull();
    const s = body.subscription!;
    expect(s.balance).toBe(250000);
    expect(s.available).toBe(250000);
    expect(s.plan_name).toBe("Shape");
    expect(s.rate_limit_per_minute).toBe(42);
    expect(s.expired).toBe(false);
    const subs = await q<{ current_period_end: number }>(
      db,
      "SELECT current_period_end FROM subscriptions WHERE workspace_id = ?",
      ws,
    );
    expect(s.period_end).toBe(subs[0]!.current_period_end);
  });

  test("expired period without renewal: expired flag, forfeited credit, one expiry ledger entry (O5)", async () => {
    // Force the period into the past without touching the wallet balance.
    // start < end is a DB check, so both move together.
    const subs = await q<{ id: string; current_period_end: number }>(
      db,
      "SELECT id, current_period_end FROM subscriptions WHERE workspace_id = ?",
      ws,
    );
    await q(
      db,
      "UPDATE subscriptions SET current_period_start = ?, current_period_end = ? WHERE id = ?",
      Date.now() - 2000,
      Date.now() - 1000,
      subs[0]!.id,
    );
    const res = await req(app, `/api/v1/workspaces/${ws}/wallet`, { cookie: memberCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscription: { expired: boolean; available: number; balance: number } | null;
    };
    expect(body.subscription).not.toBeNull();
    expect(body.subscription!.expired).toBe(true);
    expect(body.subscription!.available).toBe(0); // forfeited on read (O5)
    expect(body.subscription!.balance).toBe(0);
    const forfeits = await q<{ amount: number; memo: string; kind: string; direction: string }>(
      db,
      "SELECT le.amount, le.memo, le.kind, le.direction FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id WHERE w.workspace_id = ? AND w.kind = 'subscription' AND le.memo = 'subscription expired'",
      ws,
    );
    expect(forfeits.length).toBe(1);
    expect(forfeits[0]!.amount).toBe(250000);
    expect(forfeits[0]!.kind).toBe("adjustment");
    expect(forfeits[0]!.direction).toBe("debit");
    // Second read is idempotent: no second forfeit.
    await req(app, `/api/v1/workspaces/${ws}/wallet`, { cookie: memberCookie });
    const again = await q<{ amount: number }>(
      db,
      "SELECT le.amount FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id WHERE w.workspace_id = ? AND w.kind = 'subscription' AND le.memo = 'subscription expired'",
      ws,
    );
    expect(again.length).toBe(1);
  });
});
