// USD-priced catalog purchases (Task 2, C1): the server resolves the charge
// from the catalog row's price_usd at the transaction-time payment-settings
// FX rate — client bodies never carry an authoritative amount. USD rows
// snapshot input_currency/input_amount_text/fx_rate; legacy VND rows keep
// their unchanged VND snapshot. Settlement grants stay the frozen VND values
// from catalog creation (replay/concurrency never double-credit).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDb } from "@hoborouter/db";
import { createAuth } from "../src/auth";
import { buildApp } from "../src/app";
import { q, trackDrop, signUp, req, createWorkspace, userIdByEmail, makeInstanceAdmin } from "./helpers";
import type { buildApp as BuildApp } from "../src/app";

type App = Awaited<ReturnType<typeof BuildApp>>;

const NOW = Date.now();
const WS = "ws-usd-purchase";
const USD_BUNDLE = "b-usd-9.99";
const USD_PLAN = "p-usd-9.99";
const LEGACY_BUNDLE = "b-legacy-vnd";

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let app: App;
let payosApp: App;
let memberCookie: string;
let adminCookie: string;

// Fake payOS: injected fetch, never the internet.
const calls: { body: Record<string, unknown> }[] = [];
const fetchImpl = async (_input: string | URL, init?: RequestInit) => {
  calls.push({ body: JSON.parse(String(init?.body)) });
  return Response.json({
    code: "00",
    desc: "success",
    data: { checkoutUrl: "https://pay.test/checkout" },
  });
};

const setSetting = async (key: string, value: string) => {
  await db.execute(
    sql`INSERT INTO instance_settings (key, value, updated_at) VALUES (${key}, ${value}, ${NOW})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
};

const paymentRow = async (id: string) =>
  (
    await q(
      db,
      "SELECT amount, input_currency, input_amount_text, fx_rate_vnd_per_usd, bundle_id, subscription_plan_id, status, provider FROM payments WHERE id = ?",
      id,
    )
  )[0]!;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  trackDrop(t.drop);
  const auth = createAuth(db);
  app = await buildApp({ db, auth });
  payosApp = await buildApp({
    db,
    auth,
    payos: {
      cfg: { available: true, clientId: "c", apiKey: "k", checksumKey: "s" },
      fetch: fetchImpl,
    },
  });
  memberCookie = await signUp(app, "usd-member@test.dev", "M");
  adminCookie = await signUp(app, "usd-admin@test.dev", "A");
  await makeInstanceAdmin(db, await userIdByEmail(db, "usd-admin@test.dev"));
  await createWorkspace(db, WS, await userIdByEmail(db, "usd-member@test.dev"));
  await q(
    db,
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (?,?, 'VND', 0, 0, 0, ?)",
    `wal-${WS}`,
    WS,
    NOW,
  );
  // USD catalog seeded via Drizzle (admin USD authoring is a separate lane):
  // 9.99 USD at creation FX 26001 -> frozen price_vnd 259750, credit 5 USD
  // -> 130005 VND, plan credit 12 USD -> 312012 VND. Grants never reprice.
  await db.execute(
    sql`INSERT INTO credit_bundles (id, name, price_vnd, credit_vnd, bonus_vnd, price_usd, credit_usd, bonus_usd, creation_fx_rate_vnd_per_usd, active, created_at)
        VALUES (${USD_BUNDLE}, 'USD bundle', 259750, 130005, 0, '9.99', '5', '0', 26001, true, ${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, price_usd, credit_per_period_usd, creation_fx_rate_vnd_per_usd, period_days, rate_limit_per_minute, active, created_at)
        VALUES (${USD_PLAN}, 'USD plan', 259750, 312012, '9.99', '12', 26001, 30, 15, true, ${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO credit_bundles (id, name, price_vnd, credit_vnd, bonus_vnd, active, created_at)
        VALUES (${LEGACY_BUNDLE}, 'Legacy bundle', 50000, 50000, 0, true, ${NOW})`,
  );
  await setSetting("payment_usd_vnd_rate", "27001");
  await setSetting("first_topup_bonus_enabled", "false");
});

afterAll(() => {
  delete process.env.HBR_USD_VND_RATE;
});

const balance = async () =>
  Number(
    (
      await q(db, "SELECT balance FROM wallets WHERE workspace_id = ? AND kind = 'topup'", WS)
    )[0]!.balance,
  );

const audits = async (paymentId: string) =>
  q(db, "SELECT detail FROM audit_log WHERE action = 'payment.create' AND target = ?", paymentId);

describe("manual purchase of USD-priced catalog rows", () => {
  test("price resolves at transaction-time FX; forged client amounts ignored", async () => {
    // 9.99 USD = 999 cents; 999 * 27001 = 26,973,999 -> ceiling 269740 VND.
    // amount/usd_amount in the body are hostile junk the server must ignore.
    const res = await req(app, `/api/v1/workspaces/${WS}/bundles/${USD_BUNDLE}/purchase`, {
      method: "POST",
      cookie: memberCookie,
      body: { provider: "manual", amount: 1, usd_amount: "999" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; amount: number; status: string };
    expect(body.amount).toBe(269740);
    expect(body.status).toBe("pending");
    const row = await paymentRow(body.id);
    expect(row.amount).toBe(269740);
    expect(row.input_currency).toBe("USD");
    expect(row.input_amount_text).toBe("9.99");
    expect(row.fx_rate_vnd_per_usd).toBe(27001);
    expect(row.bundle_id).toBe(USD_BUNDLE);
    const [audit] = await audits(body.id);
    const detail = JSON.parse(String(audit!.detail));
    expect(detail.amount).toBe(269740);
    expect(detail.input_currency).toBe("USD");
    expect(detail.input_amount_text).toBe("9.99");
    expect(detail.fx_rate_vnd_per_usd).toBe(27001);
  });

  test("USD plan manual purchase resolves identically", async () => {
    const res = await req(app, `/api/v1/workspaces/${WS}/subscription-plans/${USD_PLAN}/purchase`, {
      method: "POST",
      cookie: memberCookie,
      body: { provider: "manual" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; amount: number };
    expect(body.amount).toBe(269740);
    const row = await paymentRow(body.id);
    expect(row.subscription_plan_id).toBe(USD_PLAN);
    expect(row.input_currency).toBe("USD");
    expect(row.input_amount_text).toBe("9.99");
    expect(row.fx_rate_vnd_per_usd).toBe(27001);
  });

  test("legacy VND bundle keeps the VND snapshot regardless of FX setting", async () => {
    const res = await req(app, `/api/v1/workspaces/${WS}/bundles/${LEGACY_BUNDLE}/purchase`, {
      method: "POST",
      cookie: memberCookie,
      body: { provider: "manual" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; amount: number };
    expect(body.amount).toBe(50000);
    const row = await paymentRow(body.id);
    expect(row.amount).toBe(50000);
    expect(row.input_currency).toBe("VND");
    // q() coerces all-digit text to number; assert the snapshot text exactly.
    expect(String(row.input_amount_text)).toBe("50000");
    expect(row.fx_rate_vnd_per_usd).toBeNull();
  });
});

describe("fake PayOS purchase of USD-priced catalog rows", () => {
  test("pending payment + provider call use the resolved VND amount and USD snapshot", async () => {
    const before = calls.length;
    const res = await req(payosApp, `/api/v1/workspaces/${WS}/bundles/${USD_BUNDLE}/purchase`, {
      method: "POST",
      cookie: memberCookie,
      body: { provider: "payos" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; amount: number; checkout_url: string };
    expect(body.checkout_url).toBe("https://pay.test/checkout");
    expect(body.amount).toBe(269740);
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1]!.body.amount).toBe(269740);
    const row = await paymentRow(body.id);
    expect(row.amount).toBe(269740);
    expect(row.provider).toBe("payos");
    expect(row.input_currency).toBe("USD");
    expect(row.input_amount_text).toBe("9.99");
    expect(row.fx_rate_vnd_per_usd).toBe(27001);
  });
});

describe("cap enforcement before any write or provider call", () => {
  test("over-cap manual purchase: 400, no payment row, no audit, wallet untouched", async () => {
    await setSetting("payment_max_amount_vnd", "200000");
    try {
      // Earlier tests left real USD purchases; assert no NEW over-cap row.
      const before = await q(db, "SELECT id FROM payments WHERE bundle_id = ? AND provider = 'manual' AND amount > 200000", USD_BUNDLE);
      const res = await req(app, `/api/v1/workspaces/${WS}/bundles/${USD_BUNDLE}/purchase`, {
        method: "POST",
        cookie: memberCookie,
        body: { provider: "manual" },
      });
      expect(res.status).toBe(400);
      const rows = await q(db, "SELECT id FROM payments WHERE bundle_id = ? AND provider = 'manual' AND amount > 200000", USD_BUNDLE);
      expect(rows).toHaveLength(before.length);
      expect(await balance()).toBe(0);
    } finally {
      await setSetting("payment_max_amount_vnd", "100000000");
    }
  });

  test("over-cap payos purchase: 400, no payment row, no provider call", async () => {
    await setSetting("payment_max_amount_vnd", "200000");
    try {
      const beforeCalls = calls.length;
      const before = await q(db, "SELECT id FROM payments WHERE bundle_id = ? AND amount > 200000", USD_BUNDLE);
      const res = await req(payosApp, `/api/v1/workspaces/${WS}/bundles/${USD_BUNDLE}/purchase`, {
        method: "POST",
        cookie: memberCookie,
        body: { provider: "payos" },
      });
      expect(res.status).toBe(400);
      expect(calls.length).toBe(beforeCalls);
      const rows = await q(db, "SELECT id FROM payments WHERE bundle_id = ? AND amount > 200000", USD_BUNDLE);
      expect(rows).toHaveLength(before.length);
    } finally {
      await setSetting("payment_max_amount_vnd", "100000000");
    }
  });
});

const createManual = async (path: string) => {
  const res = await req(app, path, {
    method: "POST",
    cookie: memberCookie,
    body: { provider: "manual" },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
};

describe("settlement replay and concurrency (frozen VND grants)", () => {
  test("concurrent admin completes of a USD bundle payment: one grant at creation FX", async () => {
    const paymentId = await createManual(`/api/v1/workspaces/${WS}/bundles/${USD_BUNDLE}/purchase`);
    const results = await Promise.allSettled([
      req(app, `/api/v1/admin/payments/${paymentId}/complete`, { method: "POST", cookie: adminCookie }),
      req(app, `/api/v1/admin/payments/${paymentId}/complete`, { method: "POST", cookie: adminCookie }),
    ]);
    const outcomes: string[] = [];
    for (const r of results) {
      if (r.status !== "fulfilled") throw new Error(`complete failed: ${r.reason}`);
      const body = (await r.value.json()) as { success: boolean; outcome?: string };
      if (body.success) outcomes.push(body.outcome!);
    }
    expect(outcomes.filter((o) => o === "credited")).toHaveLength(1);
    // Credit = frozen credit_vnd 130005 (creation FX 26001), not 5 * 27001.
    expect(await balance()).toBe(130005);
    const topup = await q(
      db,
      "SELECT amount FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id WHERE l.payment_id = ? AND l.kind = 'topup'",
      paymentId,
    );
    expect(topup).toHaveLength(1);
    expect(Number(topup[0]!.amount)).toBe(130005);
    const replay = await req(app, `/api/v1/admin/payments/${paymentId}/complete`, {
      method: "POST",
      cookie: adminCookie,
    });
    expect(((await replay.json()) as { outcome?: string }).outcome).toBe("already_processed");
    expect(await balance()).toBe(130005);
  });

  test("concurrent admin completes of a USD plan payment: one subscription grant", async () => {
    const paymentId = await createManual(
      `/api/v1/workspaces/${WS}/subscription-plans/${USD_PLAN}/purchase`,
    );
    const results = await Promise.allSettled([
      req(app, `/api/v1/admin/payments/${paymentId}/complete`, { method: "POST", cookie: adminCookie }),
      req(app, `/api/v1/admin/payments/${paymentId}/complete`, { method: "POST", cookie: adminCookie }),
    ]);
    let credited = 0;
    for (const r of results) {
      if (r.status !== "fulfilled") throw new Error(`complete failed: ${r.reason}`);
      const body = (await r.value.json()) as { success: boolean; outcome?: string };
      if (body.success && body.outcome === "credited") credited += 1;
    }
    expect(credited).toBe(1);
    const wallets = await q(
      db,
      "SELECT kind, balance FROM wallets WHERE workspace_id = ? ORDER BY kind",
      WS,
    );
    const sub = wallets.find((w) => w.kind === "subscription");
    // Credit = frozen credit_per_period_vnd 312012 at creation FX 26001.
    expect(Number(sub!.balance)).toBe(312012);
    expect(Number(wallets.find((w) => w.kind === "topup")!.balance)).toBe(130005);
    const led = await q(
      db,
      "SELECT amount FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id WHERE l.payment_id = ?",
      paymentId,
    );
    expect(led).toHaveLength(1);
    expect(Number(led[0]!.amount)).toBe(312012);
  });
});

describe("FX changes never move existing payments", () => {
  test("prior pending amount unchanged after an FX edit; new purchases use the new rate", async () => {
    const first = await createManual(`/api/v1/workspaces/${WS}/bundles/${USD_BUNDLE}/purchase`);
    expect((await paymentRow(first)).amount).toBe(269740);
    await setSetting("payment_usd_vnd_rate", "28000");
    // 999 * 28000 = 27,972,000 -> 279720 VND.
    const res = await req(app, `/api/v1/workspaces/${WS}/bundles/${USD_BUNDLE}/purchase`, {
      method: "POST",
      cookie: memberCookie,
      body: { provider: "manual" },
    });
    expect(res.status).toBe(201);
    const second = ((await res.json()) as { id: string }).id;
    expect((await paymentRow(second)).amount).toBe(279720);
    expect((await paymentRow(second)).fx_rate_vnd_per_usd).toBe(28000);
    // The earlier pending payment keeps its own authoritative snapshot.
    expect((await paymentRow(first)).amount).toBe(269740);
    expect((await paymentRow(first)).fx_rate_vnd_per_usd).toBe(27001);
  });
});
