// Admin plan daily_grant_vnd (migration 0019): the authored once-per-UTC-day
// VND grant is settable at plan creation, revisable through the successor
// flow (omitted = carried over from the old row), validated as a
// non-negative integer, rejected on PATCH (frozen financial term), and
// visible in the plan list.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { instanceAdmins, subscriptionPlans, users } from "../packages/db/src/schema";
import { buildApp } from "../apps/api/src/app";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";

const NOW = 1_700_000_000_000;
const ADMIN_ID = "user-dg-admin";

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
    email: "admin-dg@test",
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

async function planRow(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await db.select().from(subscriptionPlans);
  return rows.find((r) => r.id === id);
}

describe("plan create with daily_grant_vnd", () => {
  test("creates with the authored grant; omitted defaults to 0", async () => {
    const withGrant = await createPlan({
      name: "daily",
      price_vnd: 200_000,
      credit_per_period_vnd: 200_000,
      daily_grant_vnd: 5_000,
    });
    expect(withGrant.status).toBe(201);
    expect(withGrant.body.daily_grant_vnd).toBe(5_000);
    const row = await planRow(String(withGrant.body.id));
    expect(row?.daily_grant_vnd).toBe(5_000);

    const without = await createPlan({
      name: "plain",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
    });
    expect(without.status).toBe(201);
    expect(without.body.daily_grant_vnd).toBe(0);
  });

  test("rejects a negative or non-integer grant", async () => {
    const neg = await createPlan({
      name: "neg",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
      daily_grant_vnd: -1,
    });
    expect(neg.status).toBe(400);
    const frac = await createPlan({
      name: "frac",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
      daily_grant_vnd: 1.5,
    });
    expect(frac.status).toBe(400);
  });
});

describe("plan revise with daily_grant_vnd", () => {
  test("omitted grant carries over to the successor; explicit grant revises", async () => {
    const created = await createPlan({
      name: "revise-me",
      price_vnd: 300_000,
      credit_per_period_vnd: 300_000,
      daily_grant_vnd: 7_000,
    });
    const id = String(created.body.id);

    // Carry-over: price-only revision keeps the old grant.
    const carry = await revisePlan(id, {
      name: "revise-me",
      price_vnd: 350_000,
      credit_per_period_vnd: 300_000,
    });
    expect(carry.status).toBe(201);
    const carryBody = carry.body.data as Record<string, unknown>;
    expect(carryBody.daily_grant_vnd).toBe(7_000);
    const carryRow = await planRow(String(carryBody.id));
    expect(carryRow?.daily_grant_vnd).toBe(7_000);

    // Explicit revision changes the grant on the NEW row only. Revise the
    // successor (the original row is now superseded and closed).
    const revised = await revisePlan(String(carryBody.id), {
      name: "revise-me",
      price_vnd: 300_000,
      credit_per_period_vnd: 300_000,
      daily_grant_vnd: 9_000,
    });
    expect(revised.status).toBe(201);
    const revisedBody = revised.body.data as Record<string, unknown>;
    expect(revisedBody.daily_grant_vnd).toBe(9_000);
    // The old row keeps its frozen terms.
    const oldRow = await planRow(id);
    expect(oldRow?.daily_grant_vnd).toBe(7_000);
  });

  test("a grant-only change is a revision, not a no-op; identical resubmission replays", async () => {
    const created = await createPlan({
      name: "grant-only",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
      daily_grant_vnd: 1_000,
    });
    const id = String(created.body.id);
    const only = await revisePlan(id, {
      name: "grant-only",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
      daily_grant_vnd: 2_000,
    });
    expect(only.status).toBe(201);
    expect((only.body.data as Record<string, unknown>).daily_grant_vnd).toBe(2_000);

    // Same payload again: replay maps to the same successor.
    const replay = await revisePlan(id, {
      name: "grant-only",
      price_vnd: 100_000,
      credit_per_period_vnd: 100_000,
      daily_grant_vnd: 2_000,
    });
    expect(replay.status).toBe(200);
    expect((replay.body.data as Record<string, unknown>).id).toBe(
      (only.body.data as Record<string, unknown>).id,
    );
  });
});

describe("plan list and PATCH", () => {
  test("list exposes daily_grant_vnd; PATCH rejects it (frozen term)", async () => {
    const list = await listPlans();
    expect(list.status).toBe(200);
    const rows = list.body.data as Record<string, unknown>[];
    expect(rows.every((r) => typeof r.daily_grant_vnd === "number")).toBe(true);

    const patch = await api(`/api/v1/admin/subscription-plans/${String(rows[0]!.id)}`, {
      method: "PATCH",
      body: { daily_grant_vnd: 5_000 },
    });
    expect(patch.status).toBeGreaterThanOrEqual(400);
  });
});
