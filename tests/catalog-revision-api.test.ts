// Catalog revision endpoints (financial revisions): POST /admin/bundles/:id/revise
// and POST /admin/subscription-plans/:id/revise supersede a catalog row with a
// full create-validated successor in ONE transaction (successor insert + old
// active=false + successor_id link + audit), with replay/no-op/conflict
// arbitration, while old money/benefits/history stay immutable so PENDING
// payments settle at the terms actually paid for. Also covers the settlement
// contract: a superseded (deactivated) plan must NOT strand a pending payment —
// deactivation stops sales only.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { creditBundles, subscriptionPlans, users, instanceAdmins } from "../packages/db/src/schema";
import { processMockPaymentEvent } from "../packages/payments/src/credit";
import { buildApp } from "../apps/api/src/app";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const ADMIN_ID = "user-revise-admin";
const MEMBER_ID = "user-revise-member";

// Default instance FX (packages/payments DEFAULT_PAYMENT_USD_VND_RATE); tests
// that move the rate must restore it so later tests stay FX-independent.
const setFx = async (rate: number): Promise<void> => {
  await db.$client.unsafe(
    `INSERT INTO instance_settings (key, value, updated_at) VALUES ('payment_usd_vnd_rate', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(rate), NOW] as never[],
  );
};

let db: Db;
let drop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;

const fakeAuth = (userId: string | null): BetterAuthInstance => ({
  handler: async () => new Response(null, { status: 404 }),
  api: {
    getSession: async () =>
      userId ? { user: { id: userId }, session: { id: `sess-${userId}`, userId } } : null,
  },
});

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  await db.insert(users).values([
    {
      id: ADMIN_ID,
      name: "Admin",
      email: "admin@test",
      emailVerified: true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    },
    {
      id: MEMBER_ID,
      name: "Member",
      email: "member@test",
      emailVerified: true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    },
  ]);
  await db.insert(instanceAdmins).values({ user_id: ADMIN_ID, created_at: NOW });
  app = await buildApp({ db, auth: fakeAuth(ADMIN_ID) });
});

afterAll(async () => {
  await drop();
});

async function api(
  path: string,
  init?: { method?: string; body?: unknown; auth?: string | null },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.handle(
    new Request(`http://test${path}`, {
      method: init?.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

const reviseBundle = (id: string, body: unknown) =>
  api(`/api/v1/admin/bundles/${id}/revise`, { method: "POST", body });
const revisePlan = (id: string, body: unknown) =>
  api(`/api/v1/admin/subscription-plans/${id}/revise`, { method: "POST", body });

async function audits(target: string, action: string): Promise<unknown[]> {
  return db.$client.unsafe(`SELECT detail FROM audit_log WHERE target = $1 AND action = $2`, [
    target,
    action,
  ] as never[]);
}

async function bundleRow(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await db.select().from(creditBundles);
  return rows.find((r) => r.id === id);
}

async function planRow(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await db.select().from(subscriptionPlans);
  return rows.find((r) => r.id === id);
}

async function seedPendingPayment(opts: {
  id: string;
  ws: string;
  amount: number;
  orderCode: string;
  bundleId?: string;
  planId?: string;
}): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO workspaces (id, name, status, created_at) VALUES ($1, $1, 'active', $2)
     ON CONFLICT (id) DO NOTHING`,
    [opts.ws, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ($1, $2, 'VND', 0, 0, 0, $3)
     ON CONFLICT (id) DO NOTHING`,
    ["wal-" + opts.ws, opts.ws, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at, bundle_id, subscription_plan_id)
     VALUES ($1, $2, $3, 'pending', 'mock', $4, $5, $6, $7)`,
    [
      opts.id,
      opts.ws,
      opts.amount,
      opts.orderCode,
      NOW,
      opts.bundleId ?? null,
      opts.planId ?? null,
    ] as never[],
  );
}

const ev = (orderCode: string, ref: string, amount: number) => ({
  provider: "mock",
  orderCode,
  providerReference: ref,
  amount,
  rawPayload: JSON.stringify({ orderCode, ref }),
});

describe("bundle revise authorization + lookup", () => {
  test("unauthenticated revise is 401; non-admin is 403; missing bundle is 404", async () => {
    const anon = await buildApp({ db, auth: fakeAuth(null) });
    const unauth = await anon.handle(
      new Request("http://test/api/v1/admin/bundles/nope/revise", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x", price_vnd: 1, credit_vnd: 1 }),
      }),
    );
    expect(unauth.status).toBe(401);

    const member = await buildApp({ db, auth: fakeAuth(MEMBER_ID) });
    const forbidden = await member.handle(
      new Request("http://test/api/v1/admin/bundles/nope/revise", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x", price_vnd: 1, credit_vnd: 1 }),
      }),
    );
    expect(forbidden.status).toBe(403);

    const missing = await reviseBundle("bundle-does-not-exist", {
      name: "x",
      price_vnd: 100,
      credit_vnd: 100,
    });
    expect(missing.status).toBe(404);

    const missingPlan = await revisePlan("plan-does-not-exist", {
      name: "x",
      price_vnd: 100,
      credit_per_period_vnd: 100,
    });
    expect(missingPlan.status).toBe(404);
  });
});

describe("bundle revise", () => {
  test("creates ONE active successor, links the old row, old money immutable, one audit", async () => {
    const created = await api("/api/v1/admin/bundles", {
      method: "POST",
      body: { name: "B1", price_vnd: 100_000, credit_vnd: 120_000, bonus_vnd: 5_000 },
    });
    expect(created.status).toBe(201);
    const oldId = created.body.id as string;

    const rev = await reviseBundle(oldId, {
      name: "B1 v2",
      price_vnd: 150_000,
      credit_vnd: 180_000,
      bonus_vnd: 0,
    });
    expect(rev.status).toBe(201);
    const succ = rev.body.data as Record<string, unknown>;
    expect(succ.id).not.toBe(oldId);
    expect(succ.name).toBe("B1 v2");
    expect(succ.price_vnd).toBe(150_000);
    expect(succ.credit_vnd).toBe(180_000);
    expect(succ.active).toBe(true);
    expect(succ.revision_key).toBeTruthy();
    expect(succ.successor_id).toBeNull();

    const old = (await bundleRow(oldId))!;
    expect(old.active).toBe(false);
    expect(old.successor_id).toBe(succ.id);
    expect(old.revision_key).toBeNull();
    // Old money/benefits/history are immutable.
    expect(old.price_vnd).toBe(100_000);
    expect(old.credit_vnd).toBe(120_000);
    expect(old.bonus_vnd).toBe(5_000);

    expect(await audits(oldId, "bundle.revise")).toHaveLength(1);
  });

  test("identical revise replay returns the same successor, no second revision/audit", async () => {
    const created = await api("/api/v1/admin/bundles", {
      method: "POST",
      body: { name: "B-replay", price_vnd: 10_000, credit_vnd: 12_000, bonus_vnd: 0 },
    });
    const oldId = created.body.id as string;
    const body = { name: "B-replay v2", price_vnd: 11_000, credit_vnd: 13_000, bonus_vnd: 0 };
    const first = await reviseBundle(oldId, body);
    expect(first.status).toBe(201);
    const replay = await reviseBundle(oldId, body);
    expect(replay.status).toBe(200);
    expect((replay.body.data as Record<string, unknown>).id).toBe(
      (first.body.data as Record<string, unknown>).id,
    );
    const rows = await db.select().from(creditBundles);
    // Exactly one successor, and the old row links to it (successor_id points
    // successor-ward, so the link is asserted on the old row).
    expect(rows.filter((r) => r.id === oldId && r.successor_id !== null)).toHaveLength(1);
    expect(rows.find((r) => r.id === oldId)!.successor_id).toBe(
      (first.body.data as Record<string, unknown>).id as string,
    );
    expect(await audits(oldId, "bundle.revise")).toHaveLength(1);
  });

  test("distinct payload on an already-superseded bundle is 409 with no new row", async () => {
    const created = await api("/api/v1/admin/bundles", {
      method: "POST",
      body: { name: "B-conflict", price_vnd: 10_000, credit_vnd: 12_000, bonus_vnd: 0 },
    });
    const oldId = created.body.id as string;
    expect(
      (await reviseBundle(oldId, { name: "v2", price_vnd: 11_000, credit_vnd: 13_000 })).status,
    ).toBe(201);
    const distinct = await reviseBundle(oldId, {
      name: "v3",
      price_vnd: 20_000,
      credit_vnd: 21_000,
    });
    expect(distinct.status).toBe(409);
    expect((distinct.body.error as Record<string, unknown>).code).toBe("RESOURCE_SUPERSEDED");
    const rows = await db.select().from(creditBundles);
    expect(rows.filter((r) => r.id === oldId && r.successor_id !== null)).toHaveLength(1);
    expect(await audits(oldId, "bundle.revise")).toHaveLength(1);
  });

  test("no-op revise (equivalent normalized money fields) returns the old row, no audit/successor", async () => {
    const created = await api("/api/v1/admin/bundles", {
      method: "POST",
      body: { name: "B-noop", price_usd: "9.99", credit_usd: "5", bonus_vnd: 0 },
    });
    expect(created.status).toBe(201);
    const oldId = created.body.id as string;
    // "0009.99" normalizes to the stored canonical "9.99": same authored terms.
    const noop = await reviseBundle(oldId, {
      name: "B-noop",
      price_usd: "0009.99",
      credit_usd: "5",
      bonus_vnd: 0,
    });
    expect(noop.status).toBe(200);
    expect((noop.body.data as Record<string, unknown>).id).toBe(oldId);
    const old = (await bundleRow(oldId))!;
    expect(old.active).toBe(true);
    expect(old.successor_id).toBeNull();
    expect(await audits(oldId, "bundle.revise")).toHaveLength(0);
  });

  test("FX drift: identical USD revise replay still returns the same successor", async () => {
    await setFx(26_000);
    const created = await api("/api/v1/admin/bundles", {
      method: "POST",
      body: { name: "B-fx", price_usd: "9.99", credit_usd: "5", bonus_vnd: 0 },
    });
    const oldId = created.body.id as string;
    const body = { name: "B-fx v2", price_usd: "12.5", credit_usd: "6", bonus_vnd: 0 };
    // Revise under a DIFFERENT rate than creation: successor VND converts at
    // the revise-time FX and is frozen there.
    await setFx(30_000);
    const first = await reviseBundle(oldId, body);
    expect(first.status).toBe(201);
    const succId = (first.body.data as Record<string, unknown>).id;
    // Replay the identical AUTHORED body under yet another rate: the key is
    // authored-text based, so it must hit the same successor, not 409.
    await setFx(40_000);
    const replay = await reviseBundle(oldId, body);
    expect(replay.status).toBe(200);
    expect((replay.body.data as Record<string, unknown>).id).toBe(succId);
    const rows = await db.select().from(creditBundles);
    expect(rows.filter((r) => r.id === oldId && r.successor_id !== null)).toHaveLength(1);
    expect(rows.find((r) => r.id === oldId)!.successor_id).toBe(succId as string);
    expect(await audits(oldId, "bundle.revise")).toHaveLength(1);
    await setFx(26_000);
  });

  test("FX drift: identical USD resubmission on the ACTIVE row stays a no-op", async () => {
    await setFx(26_000);
    const created = await api("/api/v1/admin/bundles", {
      method: "POST",
      body: { name: "B-fx-noop", price_usd: "9.99", credit_usd: "5", bonus_vnd: 0 },
    });
    const oldId = created.body.id as string;
    await setFx(31_000);
    const noop = await reviseBundle(oldId, {
      name: "B-fx-noop",
      price_usd: "9.99",
      credit_usd: "5",
      bonus_vnd: 0,
    });
    expect(noop.status).toBe(200);
    expect((noop.body.data as Record<string, unknown>).id).toBe(oldId);
    expect(await audits(oldId, "bundle.revise")).toHaveLength(0);
    expect((await bundleRow(oldId))!.successor_id).toBeNull();
    await setFx(26_000);
  });

  test("old-terms body on a superseded row is 409 RESOURCE_SUPERSEDED, not a 200 no-op", async () => {
    const created = await api("/api/v1/admin/bundles", {
      method: "POST",
      body: { name: "B-closed", price_vnd: 10_000, credit_vnd: 12_000, bonus_vnd: 0 },
    });
    const oldId = created.body.id as string;
    expect(
      (await reviseBundle(oldId, { name: "B-closed v2", price_vnd: 11_000, credit_vnd: 13_000 }))
        .status,
    ).toBe(201);
    // Resubmit the OLD row's original terms: the row is closed — 409, never
    // a 200 of the inactive row.
    const stale = await reviseBundle(oldId, {
      name: "B-closed",
      price_vnd: 10_000,
      credit_vnd: 12_000,
      bonus_vnd: 0,
    });
    expect(stale.status).toBe(409);
    expect((stale.body.error as Record<string, unknown>).code).toBe("RESOURCE_SUPERSEDED");
    expect((await bundleRow(oldId))!.active).toBe(false);
  });

  test("invalid bodies are rejected like create; nothing is written", async () => {
    const created = await api("/api/v1/admin/bundles", {
      method: "POST",
      body: { name: "B-invalid", price_vnd: 10_000, credit_vnd: 12_000, bonus_vnd: 0 },
    });
    const oldId = created.body.id as string;
    expect(
      (await reviseBundle(oldId, { name: "x", price_vnd: 1, price_usd: "1", credit_vnd: 1 }))
        .status,
    ).toBe(400);
    expect((await bundleRow(oldId))!.successor_id).toBeNull();
    expect(await audits(oldId, "bundle.revise")).toHaveLength(0);
  });

  test("a failed conversion inside the transaction writes nothing (rollback)", async () => {
    const created = await api("/api/v1/admin/bundles", {
      method: "POST",
      body: { name: "B-rollback", price_vnd: 10_000, credit_vnd: 12_000, bonus_vnd: 0 },
    });
    const oldId = created.body.id as string;
    const res = await reviseBundle(oldId, {
      name: "huge",
      price_usd: "99999999999999999",
      credit_vnd: 1,
    });
    expect(res.status).toBe(400);
    const rows = await db.select().from(creditBundles);
    expect(rows.filter((r) => r.id === oldId && r.successor_id !== null)).toHaveLength(0);
    expect(await audits(oldId, "bundle.revise")).toHaveLength(0);
    expect((await bundleRow(oldId))!.active).toBe(true);
  });

  test("old pending bundle payment settles ORIGINAL credit+bonus after the revise", async () => {
    const ws = "ws-bundle-rev";
    const created = await api("/api/v1/admin/bundles", {
      method: "POST",
      body: { name: "B-pending", price_vnd: 100_000, credit_vnd: 120_000, bonus_vnd: 5_000 },
    });
    const oldId = created.body.id as string;
    await seedPendingPayment({
      id: "pay-bundle-rev",
      ws,
      amount: 100_000,
      orderCode: "ORD-BREV",
      bundleId: oldId,
    });
    await db.$client.unsafe(
      `INSERT INTO instance_settings (key, value, updated_at) VALUES ('first_topup_bonus_enabled','false',$1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [NOW] as never[],
    );
    const rev = await reviseBundle(oldId, {
      name: "B-pending v2",
      price_vnd: 200_000,
      credit_vnd: 999_000,
      bonus_vnd: 999_000,
    });
    expect(rev.status).toBe(201);
    const r = await processMockPaymentEvent(db, ev("ORD-BREV", "evt-brev", 100_000));
    expect(r.outcome).toBe("credited");
    const rows = await db.$client.unsafe(
      `SELECT w.kind, l.kind lkind, l.amount FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
       WHERE w.workspace_id = $1 ORDER BY l.created_at, l.id`,
      [ws] as never[],
    );
    const leg = rows as { kind: string; lkind: string; amount: string }[];
    expect(leg.map((x) => ({ kind: x.kind, lkind: x.lkind, amount: Number(x.amount) }))).toEqual([
      { kind: "topup", lkind: "topup", amount: 120_000 },
      { kind: "topup", lkind: "adjustment", amount: 5_000 },
    ]);
    // Replay never double credits.
    const replay = await processMockPaymentEvent(db, ev("ORD-BREV", "evt-brev", 100_000));
    expect(replay.outcome).toBe("already_processed");
    const rows2 = await db.$client.unsafe(
      `SELECT COUNT(*) c FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id WHERE w.workspace_id = $1`,
      [ws] as never[],
    );
    expect(Number(rows2[0]!.c)).toBe(2);
  });

  test("a NEW purchase after the edit uses the replacement bundle terms", async () => {
    const ws = "ws-bundle-new";
    const created = await api("/api/v1/admin/bundles", {
      method: "POST",
      body: { name: "B-new", price_vnd: 100_000, credit_vnd: 120_000, bonus_vnd: 0 },
    });
    const oldId = created.body.id as string;
    const rev = await reviseBundle(oldId, {
      name: "B-new v2",
      price_vnd: 100_000,
      credit_vnd: 300_000,
      bonus_vnd: 0,
    });
    const succId = (rev.body.data as Record<string, unknown>).id as string;
    await seedPendingPayment({
      id: "pay-bundle-new",
      ws,
      amount: 100_000,
      orderCode: "ORD-BNEW",
      bundleId: succId,
    });
    const r = await processMockPaymentEvent(db, ev("ORD-BNEW", "evt-bnew", 100_000));
    expect(r.outcome).toBe("credited");
    const rows = await db.$client.unsafe(
      `SELECT l.amount FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
       WHERE w.workspace_id = $1 AND l.kind = 'topup'`,
      [ws] as never[],
    );
    expect(Number(rows[0]!.amount)).toBe(300_000);
  });
});

describe("plan revise", () => {
  test("creates ONE successor with default RPM, deactivates old, links it; old RPM untouched", async () => {
    const created = await api("/api/v1/admin/subscription-plans", {
      method: "POST",
      body: {
        name: "P1",
        price_vnd: 200_000,
        credit_per_period_vnd: 250_000,
        rate_limit_per_minute: 45,
      },
    });
    expect(created.status).toBe(201);
    const oldId = created.body.id as string;
    const rev = await revisePlan(oldId, {
      name: "P1 v2",
      price_vnd: 220_000,
      credit_per_period_vnd: 260_000,
      period_days: 30,
    });
    expect(rev.status).toBe(201);
    const succ = rev.body.data as Record<string, unknown>;
    expect(succ.id).not.toBe(oldId);
    expect(succ.price_vnd).toBe(220_000);
    expect(succ.credit_per_period_vnd).toBe(260_000);
    // The successor carries the OLD plan's live RPM: rate_limit_per_minute
    // stays PATCH-editable, so a revision must never reset it to default 15.
    expect(succ.rate_limit_per_minute).toBe(45);
    expect(succ.active).toBe(true);
    expect(succ.revision_key).toBeTruthy();

    const old = (await planRow(oldId))!;
    expect(old.active).toBe(false);
    expect(old.successor_id).toBe(succ.id);
    expect(old.rate_limit_per_minute).toBe(45); // live RPM metadata unchanged
    expect(old.price_vnd).toBe(200_000);
    expect(old.credit_per_period_vnd).toBe(250_000);
    expect(await audits(oldId, "plan.revise")).toHaveLength(1);
  });

  test("plan revise rejects rate_limit_per_minute (RPM stays PATCH-only)", async () => {
    const created = await api("/api/v1/admin/subscription-plans", {
      method: "POST",
      body: { name: "P-rpm", price_vnd: 200_000, credit_per_period_vnd: 250_000 },
    });
    const oldId = created.body.id as string;
    const res = await revisePlan(oldId, {
      name: "P-rpm v2",
      price_vnd: 210_000,
      credit_per_period_vnd: 260_000,
      rate_limit_per_minute: 99,
    });
    expect(res.status).toBe(400);
    expect((res.body.error as Record<string, unknown>).code).toBe("INVALID");
    expect((await planRow(oldId))!.successor_id).toBeNull();
  });

  test("old pending plan payment on a SUPERSEDED plan settles original terms (paid plan_id kept)", async () => {
    const ws = "ws-plan-rev";
    const created = await api("/api/v1/admin/subscription-plans", {
      method: "POST",
      body: {
        name: "P-pending",
        price_vnd: 150_000,
        credit_per_period_vnd: 250_000,
        period_days: 30,
      },
    });
    const oldId = created.body.id as string;
    await seedPendingPayment({
      id: "pay-plan-rev",
      ws,
      amount: 150_000,
      orderCode: "ORD-PREV",
      planId: oldId,
    });
    const rev = await revisePlan(oldId, {
      name: "P-pending v2",
      price_vnd: 150_000,
      credit_per_period_vnd: 999_000,
      period_days: 7,
    });
    expect(rev.status).toBe(201);
    const r = await processMockPaymentEvent(db, ev("ORD-PREV", "evt-prev", 150_000));
    expect(r.outcome).toBe("credited");
    // Original plan's credit and period length — deactivation stops sales only.
    const sub = await db.$client.unsafe(
      `SELECT plan_id, current_period_start s, current_period_end e FROM subscriptions WHERE workspace_id = $1`,
      [ws] as never[],
    );
    expect(sub).toHaveLength(1);
    expect(sub[0]!.plan_id).toBe(oldId); // the plan actually paid for
    expect(Number(sub[0]!.e) - Number(sub[0]!.s)).toBe(30 * DAY_MS);
    const bal = await db.$client.unsafe(
      `SELECT balance FROM wallets WHERE workspace_id = $1 AND kind = 'subscription'`,
      [ws] as never[],
    );
    expect(Number(bal[0]!.balance)).toBe(250_000);
    // Settlement replay never double credits.
    const replay = await processMockPaymentEvent(db, ev("ORD-PREV", "evt-prev", 150_000));
    expect(replay.outcome).toBe("already_processed");
    expect(Number((await planRow(oldId))!.credit_per_period_vnd)).toBe(250_000);
  });

  test("a NEW purchase after the edit uses the replacement plan terms", async () => {
    const ws = "ws-plan-new";
    const created = await api("/api/v1/admin/subscription-plans", {
      method: "POST",
      body: { name: "P-new", price_vnd: 150_000, credit_per_period_vnd: 250_000 },
    });
    const oldId = created.body.id as string;
    const rev = await revisePlan(oldId, {
      name: "P-new v2",
      price_vnd: 150_000,
      credit_per_period_vnd: 400_000,
      period_days: 7,
    });
    const succId = (rev.body.data as Record<string, unknown>).id as string;
    await seedPendingPayment({
      id: "pay-plan-new",
      ws,
      amount: 150_000,
      orderCode: "ORD-PNEW",
      planId: succId,
    });
    const r = await processMockPaymentEvent(db, ev("ORD-PNEW", "evt-pnew", 150_000));
    expect(r.outcome).toBe("credited");
    const sub = await db.$client.unsafe(
      `SELECT plan_id, current_period_start s, current_period_end e FROM subscriptions WHERE workspace_id = $1`,
      [ws] as never[],
    );
    expect(sub[0]!.plan_id).toBe(succId);
    expect(Number(sub[0]!.e) - Number(sub[0]!.s)).toBe(7 * DAY_MS);
  });

  test("concurrent identical revise requests arbitrate to exactly one successor", async () => {
    const created = await api("/api/v1/admin/bundles", {
      method: "POST",
      body: { name: "B-race", price_vnd: 10_000, credit_vnd: 12_000, bonus_vnd: 0 },
    });
    const oldId = created.body.id as string;
    const body = { name: "B-race v2", price_vnd: 15_000, credit_vnd: 16_000, bonus_vnd: 0 };
    const [a, b] = await Promise.all([reviseBundle(oldId, body), reviseBundle(oldId, body)]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 201]);
    expect((a.body.data as Record<string, unknown>).id).toBe(
      (b.body.data as Record<string, unknown>).id,
    );
    const rows = await db.select().from(creditBundles);
    expect(rows.filter((r) => r.id === oldId && r.successor_id !== null)).toHaveLength(1);
    expect(rows.find((r) => r.id === oldId)!.successor_id).toBe(
      (a.body.data as Record<string, unknown>).id as string,
    );
    expect(await audits(oldId, "bundle.revise")).toHaveLength(1);
  });

  test("concurrent revise and pending settlement keep the paid terms", async () => {
    const ws = "ws-plan-race";
    const created = await api("/api/v1/admin/subscription-plans", {
      method: "POST",
      body: { name: "P-race", price_vnd: 150_000, credit_per_period_vnd: 250_000 },
    });
    const oldId = created.body.id as string;
    await seedPendingPayment({
      id: "pay-plan-race",
      ws,
      amount: 150_000,
      orderCode: "ORD-PRACE",
      planId: oldId,
    });
    const [settle, rev] = await Promise.all([
      processMockPaymentEvent(db, ev("ORD-PRACE", "evt-prace", 150_000)),
      revisePlan(oldId, {
        name: "P-race v2",
        price_vnd: 150_000,
        credit_per_period_vnd: 999_000,
      }),
    ]);
    expect(settle.outcome).toBe("credited");
    expect([201, 200]).toContain(rev.status);
    const bal = await db.$client.unsafe(
      `SELECT balance FROM wallets WHERE workspace_id = $1 AND kind = 'subscription'`,
      [ws] as never[],
    );
    expect(Number(bal[0]!.balance)).toBe(250_000); // paid terms, never successor terms
    expect((await planRow(oldId))!.active).toBe(false);
    expect((await planRow(oldId))!.successor_id).toBeTruthy();
  });
});
