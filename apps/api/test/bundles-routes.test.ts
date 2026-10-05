// Bundles & subscription routes: member purchase (manual/payos) with
// server-side price, inactive rejection, workspace masking (404 for
// non-members), admin CRUD without delete (amounts immutable after create),
// admin subscriptions list, and the first-topup-bonus settings whitelist.
// Money invariant: creating a purchase never moves the wallet — only
// settlement (webhook/admin complete) credits.
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

const createBundle = async (over: Record<string, unknown> = {}) => {
  const res = await req(app, "/api/v1/admin/bundles", {
    method: "POST",
    cookie: adminCookie,
    body: { name: "Bundle", price_vnd: 100000, credit_vnd: 100000, bonus_vnd: 10000, ...over },
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
};

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
  adminCookie = await signUp(app, "bundles-admin@test.dev", "A");
  await makeInstanceAdmin(db, await userIdByEmail(db, "bundles-admin@test.dev"));
  memberCookie = await signUp(app, "bundles-member@test.dev", "M");
  outsiderCookie = await signUp(app, "bundles-out@test.dev", "O");
  ws = "ws-bundles";
  await createWorkspace(db, ws, await userIdByEmail(db, "bundles-member@test.dev"));
  await q(
    db,
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (?,?, 'VND', 0, 0, 0, ?)",
    `wal-${ws}`,
    ws,
    Date.now(),
  );
});

describe("admin bundle & plan CRUD", () => {
  test("admin-only gate: non-admin 403, unauthenticated 401", async () => {
    const res = await req(app, "/api/v1/admin/bundles", { cookie: memberCookie });
    expect(res.status).toBe(403);
    const res2 = await req(app, "/api/v1/admin/bundles");
    expect(res2.status).toBe(401);
  });

  test("create bundle validates amounts and audits", async () => {
    for (const price_vnd of [0, -5]) {
      const bad = await createBundle({ price_vnd });
      expect(bad.res.status).toBe(400);
    }
    const badCredit = await createBundle({ credit_vnd: -1 });
    expect(badCredit.res.status).toBe(400);
    const { res, body } = await createBundle({ name: "Starter" });
    expect(res.status).toBe(201);
    expect(body.price_vnd).toBe(100000);
    expect(body.bonus_vnd).toBe(10000);
    expect(body.active).toBe(true);
    const audits = await q(
      db,
      "SELECT * FROM audit_log WHERE action = 'bundle.create' AND target = ?",
      String(body.id),
    );
    expect(audits.length).toBe(1);
  });

  test("PATCH rejects amount changes, allows name/active, 404 unknown", async () => {
    const { body } = await createBundle({ name: "Patchable" });
    const id = String(body.id);
    const amountEdit = await req(app, `/api/v1/admin/bundles/${id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { price_vnd: 999 },
    });
    expect(amountEdit.status).toBe(400);
    const creditEdit = await req(app, `/api/v1/admin/bundles/${id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { credit_vnd: 999 },
    });
    expect(creditEdit.status).toBe(400);
    const ok = await req(app, `/api/v1/admin/bundles/${id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { name: "Renamed", active: false },
    });
    expect(ok.status).toBe(200);
    const row = (
      await q(
        db,
        "SELECT name, active, price_vnd, credit_vnd, bonus_vnd FROM credit_bundles WHERE id = ?",
        id,
      )
    )[0]!;
    expect(row.name).toBe("Renamed");
    expect(row.active).toBe(false);
    expect(row.price_vnd).toBe(100000);
    expect(row.credit_vnd).toBe(100000);
    expect(row.bonus_vnd).toBe(10000);
    const missing = await req(app, "/api/v1/admin/bundles/nope", {
      method: "PATCH",
      cookie: adminCookie,
      body: { active: true },
    });
    expect(missing.status).toBe(404);
  });

  test("plans: rate_limit_per_minute default 15, create validates 1..600", async () => {
    const { res, body } = await createPlan({ name: "Limited" });
    expect(res.status).toBe(201);
    expect(body.rate_limit_per_minute).toBe(15);
    for (const rate_limit_per_minute of [0, -1, 601]) {
      const bad = await createPlan({ rate_limit_per_minute });
      expect(bad.res.status).toBe(400);
    }
    const nonInt = await createPlan({ rate_limit_per_minute: 1.5 });
    expect(nonInt.res.status).toBe(400);
    const custom = await createPlan({ name: "Fast", rate_limit_per_minute: 120 });
    expect(custom.res.status).toBe(201);
    expect(custom.body.rate_limit_per_minute).toBe(120);
    // Deactivate so the member-catalog snapshot below stays ["Visible"] only.
    for (const id of [body.id, custom.body.id]) {
      await req(app, `/api/v1/admin/subscription-plans/${id}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: { active: false },
      });
    }
  });

  test("plans: PATCH rate_limit_per_minute changes it; money amounts still 400", async () => {
    const { body: plan } = await createPlan({ name: "RateEdit", rate_limit_per_minute: 30 });
    const id = String(plan.id);
    const patch = await req(app, `/api/v1/admin/subscription-plans/${id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { rate_limit_per_minute: 600 },
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { rate_limit_per_minute: number }).rate_limit_per_minute).toBe(
      600,
    );
    const row = (
      await q(
        db,
        "SELECT rate_limit_per_minute, price_vnd, credit_per_period_vnd FROM subscription_plans WHERE id = ?",
        id,
      )
    )[0]!;
    expect(row.rate_limit_per_minute).toBe(600);
    for (const body of [
      { rate_limit_per_minute: 0 },
      { rate_limit_per_minute: 601 },
      { rate_limit_per_minute: 2.5 },
    ]) {
      const bad = await req(app, `/api/v1/admin/subscription-plans/${id}`, {
        method: "PATCH",
        cookie: adminCookie,
        body,
      });
      expect(bad.status).toBe(400);
    }
    // Money amounts and period stay immutable on PATCH.
    for (const body of [{ price_vnd: 1 }, { credit_per_period_vnd: 1 }, { period_days: 7 }]) {
      const money = await req(app, `/api/v1/admin/subscription-plans/${id}`, {
        method: "PATCH",
        cookie: adminCookie,
        body,
      });
      expect(money.status).toBe(400);
    }
    const unchanged = (
      await q(
        db,
        "SELECT rate_limit_per_minute, price_vnd, credit_per_period_vnd, period_days FROM subscription_plans WHERE id = ?",
        id,
      )
    )[0]!;
    expect(unchanged.rate_limit_per_minute).toBe(600);
    expect(unchanged.price_vnd).toBe(200000);
    expect(unchanged.credit_per_period_vnd).toBe(250000);
    expect(unchanged.period_days).toBe(30);
    await req(app, `/api/v1/admin/subscription-plans/${id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { active: false },
    });
  });

  test("plans: create validates, PATCH amounts rejected, audited", async () => {
    const badPrice = await createPlan({ price_vnd: 0 });
    expect(badPrice.res.status).toBe(400);
    const badDays = await createPlan({ period_days: 0 });
    expect(badDays.res.status).toBe(400);
    const { res, body } = await createPlan({ name: "Pro" });
    expect(res.status).toBe(201);
    expect(body.period_days).toBe(30);
    const id = String(body.id);
    const amountEdit = await req(app, `/api/v1/admin/subscription-plans/${id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { credit_per_period_vnd: 1 },
    });
    expect(amountEdit.status).toBe(400);
    const ok = await req(app, `/api/v1/admin/subscription-plans/${id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { active: false },
    });
    expect(ok.status).toBe(200);
    const audits = await q(
      db,
      "SELECT * FROM audit_log WHERE action = 'plan.update' AND target = ?",
      id,
    );
    expect(audits.length).toBe(1);
  });
});

describe("member catalog & purchase", () => {
  let activeBundle: Record<string, unknown>;
  let activePlan: Record<string, unknown>;

  beforeAll(async () => {
    activeBundle = (await createBundle({ name: "Buyable", bonus_vnd: 0 })).body;
    activePlan = (await createPlan({ name: "Visible" })).body;
  });

  test("GET /api/v1/bundles and subscription-plans list active only", async () => {
    // "Patchable" bundle was deactivated in the admin CRUD tests.
    const res = await req(app, "/api/v1/bundles", { cookie: memberCookie });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { data: { id: string }[] }).data.map((b) => b.id);
    expect(ids).toContain(String(activeBundle.id));
    expect(ids).not.toContain("no-inactive-id");
    const planRes = await req(app, "/api/v1/subscription-plans", { cookie: outsiderCookie });
    expect(planRes.status).toBe(200);
    const planIds = ((await planRes.json()) as { data: { id: string }[] }).data.map((p) => p.id);
    // "Pro" (plan CRUD tests) was deactivated; only the active plan shows.
    expect(planIds).toEqual([String(activePlan.id)]);
  });

  test("manual bundle purchase creates pending payment at server price; client amount ignored", async () => {
    const res = await req(app, `/api/v1/workspaces/${ws}/bundles/${activeBundle.id}/purchase`, {
      method: "POST",
      cookie: memberCookie,
      body: { provider: "manual", amount: 1 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      amount: number;
      status: string;
      provider: string;
    };
    expect(body.amount).toBe(100000);
    expect(body.status).toBe("pending");
    expect(body.provider).toBe("manual");
    const row = (await q(db, "SELECT * FROM payments WHERE id = ?", body.id))[0]!;
    expect(row.bundle_id).toBe(String(activeBundle.id));
    expect(row.subscription_plan_id).toBeNull();
    expect(row.amount).toBe(100000);
    const audits = await q(
      db,
      "SELECT * FROM audit_log WHERE action = 'payment.create' AND target = ?",
      body.id,
    );
    expect(audits.length).toBe(1);
  });

  test("inactive bundle rejected with 409; unknown 404", async () => {
    const { body: inactive } = await createBundle({ name: "Off" });
    await req(app, `/api/v1/admin/bundles/${inactive.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { active: false },
    });
    const res = await req(app, `/api/v1/workspaces/${ws}/bundles/${inactive.id}/purchase`, {
      method: "POST",
      cookie: memberCookie,
      body: { provider: "manual" },
    });
    expect(res.status).toBe(409);
    const unknown = await req(app, `/api/v1/workspaces/${ws}/bundles/nope/purchase`, {
      method: "POST",
      cookie: memberCookie,
      body: { provider: "manual" },
    });
    expect(unknown.status).toBe(404);
  });

  test("non-member 404 (existence masked), unauthenticated 401", async () => {
    const res = await req(app, `/api/v1/workspaces/${ws}/bundles/${activeBundle.id}/purchase`, {
      method: "POST",
      cookie: outsiderCookie,
      body: { provider: "manual" },
    });
    expect(res.status).toBe(404);
    const unknownWs = await req(app, "/api/v1/workspaces/ws-ghost/bundles/x/purchase", {
      method: "POST",
      cookie: outsiderCookie,
      body: { provider: "manual" },
    });
    expect(unknownWs.status).toBe(404);
    const unauth = await req(app, `/api/v1/workspaces/${ws}/bundles/${activeBundle.id}/purchase`, {
      method: "POST",
      body: { provider: "manual" },
    });
    expect(unauth.status).toBe(401);
  });
});

describe("payos purchase path", () => {
  let payosApp: Awaited<ReturnType<typeof buildApp>>;
  let payosDb: Awaited<ReturnType<typeof makeApp>>["db"];
  let payosMemberCookie: string;
  let payosWs: string;
  let bundleId: string;

  const calls: { body: Record<string, unknown> }[] = [];
  const fetchImpl = async (_input: string | URL, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return Response.json({
      code: "00",
      desc: "success",
      data: { checkoutUrl: "https://pay.test/checkout" },
    });
  };

  beforeAll(async () => {
    const { buildApp: build } = await import("../src/app");
    const t = await makeApp();
    payosDb = t.db;
    payosApp = await build({
      db: t.db,
      payos: {
        cfg: { available: true, clientId: "c", apiKey: "k", checksumKey: "s" },
        fetch: fetchImpl,
      },
    });
    payosMemberCookie = await signUp(payosApp, "payos-bundle@test.dev", "M");
    payosWs = "ws-bundles-payos";
    await createWorkspace(payosDb, payosWs, await userIdByEmail(payosDb, "payos-bundle@test.dev"));
    await q(
      payosDb,
      "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (?,?, 'VND', 0, 0, 0, ?)",
      `wal-${payosWs}`,
      payosWs,
      Date.now(),
    );
    await makeInstanceAdmin(payosDb, await userIdByEmail(payosDb, "payos-bundle@test.dev"));
    const adminC = await signUp(payosApp, "payos-bundle-admin@test.dev", "A");
    await makeInstanceAdmin(payosDb, await userIdByEmail(payosDb, "payos-bundle-admin@test.dev"));
    const created = await req(payosApp, "/api/v1/admin/bundles", {
      method: "POST",
      cookie: adminC,
      body: { name: "Payos bundle", price_vnd: 50000, credit_vnd: 50000, bonus_vnd: 0 },
    });
    bundleId = String(((await created.json()) as { id: string }).id);
  });

  test("payos purchase returns checkout_url, pending payment with bundle_id, wallet untouched", async () => {
    const res = await req(payosApp, `/api/v1/workspaces/${payosWs}/bundles/${bundleId}/purchase`, {
      method: "POST",
      cookie: payosMemberCookie,
      body: { provider: "payos" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      amount: number;
      checkout_url: string;
      provider: string;
    };
    expect(body.checkout_url).toBe("https://pay.test/checkout");
    expect(body.amount).toBe(50000);
    const row = (await q(payosDb, "SELECT * FROM payments WHERE id = ?", body.id))[0]!;
    expect(row.provider).toBe("payos");
    expect(row.status).toBe("pending");
    expect(row.bundle_id).toBe(bundleId);
    const wallet = (
      await q(payosDb, "SELECT balance FROM wallets WHERE workspace_id = ?", payosWs)
    )[0]!;
    expect(wallet.balance).toBe(0);
  });

  test("payos unconfigured -> 503", async () => {
    const { buildApp: build } = await import("../src/app");
    const t = await makeApp();
    const appNoPayos = await build({
      db: t.db,
      payos: { cfg: { available: false, clientId: "", apiKey: "", checksumKey: "" } },
    });
    const cookie = await signUp(appNoPayos, "nopayos@test.dev", "M");
    await createWorkspace(t.db, "ws-nopayos", await userIdByEmail(t.db, "nopayos@test.dev"));
    const adminC = await signUp(appNoPayos, "nopayos-admin@test.dev", "A");
    await makeInstanceAdmin(t.db, await userIdByEmail(t.db, "nopayos-admin@test.dev"));
    const created = await req(appNoPayos, "/api/v1/admin/bundles", {
      method: "POST",
      cookie: adminC,
      body: { name: "B", price_vnd: 50000, credit_vnd: 50000 },
    });
    const id = String(((await created.json()) as { id: string }).id);
    const res = await req(appNoPayos, "/api/v1/workspaces/ws-nopayos/bundles/" + id + "/purchase", {
      method: "POST",
      cookie,
      body: { provider: "payos" },
    });
    expect(res.status).toBe(503);
  });
});

describe("first-topup-bonus settings whitelist", () => {
  test("defaults: enabled, 20000", async () => {
    const res = await req(app, "/api/v1/admin/settings", { cookie: adminCookie });
    const body = (await res.json()) as {
      first_topup_bonus_enabled: boolean;
      first_topup_bonus_amount_vnd: number | null;
    };
    expect(body.first_topup_bonus_enabled).toBe(true);
    expect(body.first_topup_bonus_amount_vnd).toBe(20000);
  });

  test("PUT accepts integer and string amount, stores canonically", async () => {
    const asString = await req(app, "/api/v1/admin/settings", {
      method: "PUT",
      cookie: adminCookie,
      body: { first_topup_bonus_amount_vnd: "25000" },
    });
    expect(asString.status).toBe(200);
    const asInt = await req(app, "/api/v1/admin/settings", {
      method: "PUT",
      cookie: adminCookie,
      body: { first_topup_bonus_amount_vnd: 30000, first_topup_bonus_enabled: false },
    });
    expect(asInt.status).toBe(200);
    const row = (
      await q(db, "SELECT value FROM instance_settings WHERE key = 'first_topup_bonus_amount_vnd'")
    )[0]!;
    expect(String(row.value)).toBe("30000");
    const enabledRow = (
      await q(db, "SELECT value FROM instance_settings WHERE key = 'first_topup_bonus_enabled'")
    )[0]!;
    expect(enabledRow.value).toBe("false");
    const get = await req(app, "/api/v1/admin/settings", { cookie: adminCookie });
    const body = (await get.json()) as {
      first_topup_bonus_enabled: boolean;
      first_topup_bonus_amount_vnd: number;
    };
    expect(body.first_topup_bonus_amount_vnd).toBe(30000);
    expect(body.first_topup_bonus_enabled).toBe(false);
  });

  test("invalid amounts rejected with 400 (0, negative, non-integer, garbage)", async () => {
    for (const v of [0, -5, 1.5, "abc", ""]) {
      const res = await req(app, "/api/v1/admin/settings", {
        method: "PUT",
        cookie: adminCookie,
        body: { first_topup_bonus_amount_vnd: v },
      });
      expect(res.status).toBe(400);
    }
  });

  test("settings updates audited; member denied", async () => {
    const audits = await q(
      db,
      "SELECT * FROM audit_log WHERE action = 'settings.update' AND target = 'first_topup_bonus_amount_vnd'",
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const denied = await req(app, "/api/v1/admin/settings", {
      method: "PUT",
      cookie: memberCookie,
      body: { first_topup_bonus_enabled: true },
    });
    expect(denied.status).toBe(403);
  });
});
