// Admin plan daily_grant_usd (migration 0020): the once-per-UTC-day grant can
// be authored as EXACT USD text (e.g. "5" = 5 USD/day). The API derives the
// integer VND grant ONCE at the shared creation FX snapshot (ceiling, BigInt
// only), stores both the authored text and the frozen FX on the plan row,
// never recomputes the stored VND on FX change, carries both fields through
// the successor/revise flow (omitted = carried over), and exposes both on the
// admin list and the public plans endpoint (public daily grant stays FROZEN
// even while USD prices requote at the current canonical rate).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import {
  instanceAdmins,
  instanceSettings,
  subscriptionPlans,
  users,
} from "../packages/db/src/schema";
import { buildApp } from "../apps/api/src/app";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";

const NOW = 1_700_000_000_000;
const ADMIN_ID = "user-dgu-admin";
// Default canonical payment FX (packages/payments DEFAULT_PAYMENT_USD_VND_RATE).
const DEFAULT_FX = 26_000;
const CHANGED_FX = 30_000;
// ceil(500 cents * 26000 / 100) = 130000.
const FIVE_USD_VND_AT_DEFAULT = 130_000;

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
  await db.insert(users).values({
    id: ADMIN_ID,
    name: "Admin",
    email: "admin-dgu@test",
    emailVerified: true,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  });
  await db.insert(instanceAdmins).values({ user_id: ADMIN_ID, created_at: NOW });
  app = await buildApp({ db, auth: fakeAuth(ADMIN_ID) });
});

afterAll(async () => {
  await drop();
});

async function api(
  path: string,
  init?: { method?: string; body?: unknown },
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

const createPlan = (body: unknown) =>
  api("/api/v1/admin/subscription-plans", { method: "POST", body });
const revisePlan = (id: string, body: unknown) =>
  api(`/api/v1/admin/subscription-plans/${id}/revise`, { method: "POST", body });
const listPlans = () => api("/api/v1/admin/subscription-plans");
const publicPlans = () => api("/api/v1/public/subscription-plans");

async function planRow(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await db.select().from(subscriptionPlans);
  return rows.find((r) => r.id === id);
}

async function setFxRate(rate: number): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ key: "payment_usd_vnd_rate", value: String(rate), updated_at: NOW })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: String(rate), updated_at: NOW },
    });
}

const data = (r: { body: Record<string, unknown> }): Record<string, unknown> =>
  (r.body.data as Record<string, unknown>) ?? r.body;

describe("plan create with daily_grant_usd", () => {
  test("5 USD/day derives the integer VND grant once at the frozen FX snapshot", async () => {
    const res = await createPlan({
      name: "usd-daily",
      price_vnd: 200_000,
      credit_per_period_vnd: 200_000,
      daily_grant_usd: "5",
    });
    expect(res.status).toBe(201);
    const row = await planRow(String(res.body.id));
    expect(row?.daily_grant_usd).toBe("5");
    expect(row?.daily_grant_vnd).toBe(FIVE_USD_VND_AT_DEFAULT);
    expect(Number(row?.creation_fx_rate_vnd_per_usd)).toBe(DEFAULT_FX);
    const body = res.body as Record<string, unknown>;
    expect(body.daily_grant_usd).toBe("5");
    expect(body.daily_grant_vnd).toBe(FIVE_USD_VND_AT_DEFAULT);
  });

  test("mixed authoring: USD price/credit plus USD daily grant share one FX snapshot", async () => {
    const res = await createPlan({
      name: "usd-all",
      price_usd: "10",
      credit_per_period_usd: "8",
      daily_grant_usd: "2.50",
    });
    expect(res.status).toBe(201);
    const row = await planRow(String(res.body.id));
    expect(row?.daily_grant_usd).toBe("2.50");
    // ceil(250 cents * 26000 / 100) = 65000.
    expect(row?.daily_grant_vnd).toBe(65_000);
    expect(Number(row?.creation_fx_rate_vnd_per_usd)).toBe(DEFAULT_FX);
  });

  test("rejects both currency variants of the daily grant field", async () => {
    const res = await createPlan({
      name: "both",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
      daily_grant_vnd: 5_000,
      daily_grant_usd: "5",
    });
    expect(res.status).toBe(400);
  });

  test("rejects invalid USD grant text (bad syntax, negative, >2 decimals)", async () => {
    for (const bad of ["5.999", "-5", "abc", "1,000"]) {
      const res = await createPlan({
        name: `bad-${bad}`,
        price_vnd: 100_000,
        credit_per_period_vnd: 100_000,
        daily_grant_usd: bad,
      });
      expect(res.status).toBe(400);
    }
    const none = await planRow("bad-5.999");
    expect(none).toBeUndefined();
  });

  test("daily_grant_usd omitted keeps the VND-only contract (usd null, fx null)", async () => {
    const res = await createPlan({
      name: "vnd-only",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
      daily_grant_vnd: 5_000,
    });
    expect(res.status).toBe(201);
    const row = await planRow(String(res.body.id));
    expect(row?.daily_grant_usd).toBeNull();
    expect(row?.daily_grant_vnd).toBe(5_000);
    expect(row?.creation_fx_rate_vnd_per_usd).toBeNull();
  });
});

describe("plan revise with daily_grant_usd", () => {
  test("omitted grant carries both authored USD text and frozen VND to the successor", async () => {
    const created = await createPlan({
      name: "carry",
      price_vnd: 300_000,
      credit_per_period_vnd: 300_000,
      daily_grant_usd: "5",
    });
    const id = String(created.body.id);
    await setFxRate(CHANGED_FX);
    const carry = await revisePlan(id, {
      name: "carry",
      price_vnd: 350_000,
      credit_per_period_vnd: 300_000,
    });
    expect(carry.status).toBe(201);
    const row = await planRow(String(data(carry).id));
    // Frozen, never recomputed at the new FX (would be 150000 at 30000).
    expect(row?.daily_grant_usd).toBe("5");
    expect(row?.daily_grant_vnd).toBe(FIVE_USD_VND_AT_DEFAULT);
    await setFxRate(DEFAULT_FX);
  });

  test("identical USD-authoring resubmission after an FX change is a replay, not a revision", async () => {
    const created = await createPlan({
      name: "fx-freeze",
      price_usd: "10",
      credit_per_period_usd: "8",
      daily_grant_usd: "5",
    });
    const id = String(created.body.id);
    await setFxRate(CHANGED_FX);
    const replay = await revisePlan(id, {
      name: "fx-freeze",
      price_usd: "10",
      credit_per_period_usd: "8",
      daily_grant_usd: "5",
    });
    // Same authored terms: no-op (200), not a successor re-derived at 30000.
    expect(replay.status).toBe(200);
    expect(String(data(replay).id)).toBe(id);
    const row = await planRow(id);
    expect(row?.daily_grant_vnd).toBe(FIVE_USD_VND_AT_DEFAULT);
    await setFxRate(DEFAULT_FX);
  });

  test("explicit VND grant on a USD-authored row revises and clears the USD text", async () => {
    const created = await createPlan({
      name: "usd-to-vnd",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
      daily_grant_usd: "5",
    });
    const id = String(created.body.id);
    const revised = await revisePlan(id, {
      name: "usd-to-vnd",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
      daily_grant_vnd: 9_000,
    });
    expect(revised.status).toBe(201);
    const row = await planRow(String(data(revised).id));
    expect(row?.daily_grant_usd).toBeNull();
    expect(row?.daily_grant_vnd).toBe(9_000);
    // USD authoring is gone entirely: no FX snapshot either.
    expect(row?.creation_fx_rate_vnd_per_usd).toBeNull();
  });

  test("explicit USD grant change re-derives at the successor's fresh FX snapshot", async () => {
    const created = await createPlan({
      name: "usd-revise",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
      daily_grant_usd: "5",
    });
    const id = String(created.body.id);
    await setFxRate(CHANGED_FX);
    const revised = await revisePlan(id, {
      name: "usd-revise",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
      daily_grant_usd: "6",
    });
    expect(revised.status).toBe(201);
    const row = await planRow(String(data(revised).id));
    expect(row?.daily_grant_usd).toBe("6");
    // ceil(600 cents * 30000 / 100) = 180000.
    expect(row?.daily_grant_vnd).toBe(180_000);
    expect(Number(row?.creation_fx_rate_vnd_per_usd)).toBe(CHANGED_FX);
    await setFxRate(DEFAULT_FX);
  });

  test("grant-only change is a revision; PATCH still rejects the field", async () => {
    const created = await createPlan({
      name: "grant-only-usd",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
    });
    const id = String(created.body.id);
    const only = await revisePlan(id, {
      name: "grant-only-usd",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
      daily_grant_usd: "1",
    });
    expect(only.status).toBe(201);
    expect((data(only) as Record<string, unknown>).daily_grant_usd).toBe("1");
    const patch = await api(`/api/v1/admin/subscription-plans/${id}`, {
      method: "PATCH",
      body: { daily_grant_usd: "2" },
    });
    expect(patch.status).toBeGreaterThanOrEqual(400);
  });
});

describe("admin list and public plans expose the authored USD daily grant", () => {
  test("admin list includes daily_grant_usd", async () => {
    const list = await listPlans();
    expect(list.status).toBe(200);
    const rows = list.body.data as Record<string, unknown>[];
    expect(rows.some((r) => r.daily_grant_usd === "5")).toBe(true);
  });

  test("public plans: daily grant stays FROZEN while USD price requotes at current FX", async () => {
    await setFxRate(CHANGED_FX);
    const pub = await publicPlans();
    expect(pub.status).toBe(200);
    const rows = pub.body.data as Record<string, unknown>[];
    const frozen = rows.find((r) => r.daily_grant_usd === "5" && r.name === "fx-freeze");
    expect(frozen).toBeDefined();
    // Daily grant: never recomputed.
    expect(frozen?.daily_grant_vnd).toBe(FIVE_USD_VND_AT_DEFAULT);
    // Contrast: the USD PRICE is quoted at the CURRENT canonical rate.
    expect(frozen?.price_vnd).toBe(10 * CHANGED_FX);
    expect(frozen?.price_usd).toBe("10");
    await setFxRate(DEFAULT_FX);
  });
});
