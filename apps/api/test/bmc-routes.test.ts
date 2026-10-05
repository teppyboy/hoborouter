// Mounted-app registration of the BMC plugins in src/app.ts. Contract:
// the seven route modules (publicCatalogRoutes, supportSettingsRoutes,
// adminBusinessRoutes, adminPromotionsRoutes, promotionsRoutes,
// supportLeadRoutes, adminSupportLeadRoutes) are reachable through buildApp
// BEFORE the /api/* 404 wildcard, with their auth behavior intact:
// public catalog/instance/plans 200, admin surfaces 401 anon / 403 non-admin,
// anonymous lead intake 201 (no TURNSTILE configured), member redeem credits
// the topup wallet, unknown API paths still 404. Real Postgres via makeApp.
import { describe, expect, test, beforeAll } from "bun:test";
import { makeApp, q, signUp, createWorkspace, userIdByEmail } from "./helpers";
import { generatePromoCode, hashPromoCode } from "../src/routes/admin-promotions";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let memberCookie: string;
let wsId: string;
const PROMO_CODE = generatePromoCode();

const req = (path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) => {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app.handle(
    new Request("http://localhost" + path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );
};

describe("mounted BMC plugins in buildApp", () => {
  test("public catalog/instance/subscription-plans answer 200", async () => {
    for (const path of [
      "/api/v1/public/catalog",
      "/api/v1/public/instance",
      "/api/v1/public/subscription-plans",
    ]) {
      const res = await req(path);
      expect(res.status).toBe(200);
    }
  });

  test("admin business/promos/leads/support-settings: 401 anon, 403 non-admin", async () => {
    const surfaces = [
      "/api/v1/admin/business",
      "/api/v1/admin/promotions",
      "/api/v1/admin/support-leads",
      "/api/v1/admin/support-settings",
    ];
    for (const path of surfaces) {
      const unauth = await req(path);
      expect(unauth.status).toBe(401);
      const nonAdmin = await req(path, { cookie: memberCookie });
      expect(nonAdmin.status).toBe(403);
    }
  });

  test("public lead intake POST /api/v1/support/integration answers 201", async () => {
    const res = await req("/api/v1/support/integration", {
      method: "POST",
      body: {
        contact_email: "lead@bmc-routes.test",
        contact_channel: "telegram: @bmc",
        message: "Please integrate our chatbot, this is a long enough message.",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("open");
    const rows = await q<{ contact_email: string; status: string }>(
      db,
      "SELECT contact_email, status FROM support_leads WHERE contact_email = ?",
      "lead@bmc-routes.test",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("open");
  });

  test("promo redeem: 401 anon, valid member credits topup wallet", async () => {
    const path = `/api/v1/workspaces/${wsId}/promotions/redeem`;
    const unauth = await req(path, { method: "POST", body: { code: PROMO_CODE } });
    expect(unauth.status).toBe(401);

    const res = await req(path, {
      method: "POST",
      cookie: memberCookie,
      body: { code: PROMO_CODE },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credited_vnd: number };
    expect(body.credited_vnd).toBe(50000);
    const ledger = await q<{ n: number }>(
      db,
      "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE kind = 'adjustment' AND direction = 'credit'",
    );
    expect(ledger[0]!.n).toBe(1);
    const redemptions = await q<{ n: number }>(
      db,
      "SELECT COUNT(*)::int AS n FROM promo_redemptions",
    );
    expect(redemptions[0]!.n).toBe(1);
  });

  test("unknown API path still answers 404", async () => {
    const res = await req("/api/v1/definitely-not-a-route");
    expect(res.status).toBe(404);
  });
});

beforeAll(async () => {
  ({ app, db } = await makeApp());
  // Lead intake is Turnstile-enforced only when the server-side secret is
  // configured; this slice tests the config-off path.
  delete process.env.TURNSTILE_SECRET_KEY;
  memberCookie = await signUp(app, "bmc-member@test.dev", "M");
  const userId = await userIdByEmail(db, "bmc-member@test.dev");
  wsId = "ws-bmc-routes";
  await createWorkspace(db, wsId, userId);
  await q(
    db,
    `INSERT INTO wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at)
     VALUES (?,?,?,?,0,0,0,?)`,
    `wal-${wsId}`,
    wsId,
    "topup",
    "VND",
    Date.now(),
  );
  await q(
    db,
    `INSERT INTO promo_codes (id, code_hash, name, amount_vnd, max_uses, uses, expires_at, active, created_at)
     VALUES (?,?,?,?,?,0,NULL,true,?)`,
    "pc-bmc-routes",
    hashPromoCode(PROMO_CODE),
    "BMC mounted promo",
    50000,
    10,
    Date.now(),
  );
});
