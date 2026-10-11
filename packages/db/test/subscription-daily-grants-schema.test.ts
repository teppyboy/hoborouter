// Daily-grant schema (migration 0019): subscription_plans.daily_grant_vnd is
// a bounded non-negative integer VND column defaulting to 0; the
// subscription_daily_grants gate table enforces one grant per
// (workspace, subscription, UTC day) with a 'YYYY-MM-DD' day format check and
// ledger-kind 'subscription_daily_grant' accepted on ledger_entries.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../src/testing";
import { isUniqueViolation, pgErrorCode } from "../src/errors";
import {
  ledgerEntries,
  subscriptionDailyGrants,
  subscriptionPlans,
  subscriptions,
  wallets,
  workspaces,
} from "../src/schema";

let t: TestDb;
let d: TestDb["db"];

function wsRow(id: string): typeof workspaces.$inferInsert {
  return { id, name: "ws", status: "active", created_at: 1 };
}

async function expectReject(p: PromiseLike<unknown>): Promise<unknown> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  return err;
}

beforeAll(async () => {
  t = await createTestDb();
  d = t.db;
  await d.insert(workspaces).values([wsRow("ws-a")]);
  await d.insert(wallets).values({
    id: "wal-a",
    workspace_id: "ws-a",
    currency: "VND",
    kind: "subscription",
    balance: 100,
    reserved: 0,
    version: 0,
    created_at: 1,
  });
  await d.insert(subscriptionPlans).values({
    id: "plan-a",
    name: "plan",
    price_vnd: 100_000,
    credit_per_period_vnd: 100_000,
    period_days: 30,
    daily_grant_vnd: 5_000,
    active: true,
    created_at: 1,
  });
  await d.insert(subscriptions).values({
    id: "sub-a",
    workspace_id: "ws-a",
    plan_id: "plan-a",
    status: "active",
    current_period_start: 1,
    current_period_end: 2,
    created_at: 1,
  });
  await d.insert(ledgerEntries).values({
    id: "led-seed",
    wallet_id: "wal-a",
    direction: "credit",
    amount: 100,
    kind: "topup",
    balance_after: 100,
    memo: "seed",
    created_at: 1,
  });
});

afterAll(async () => {
  await t.drop();
});

function grantRow(over: Partial<typeof subscriptionDailyGrants.$inferInsert> = {}) {
  return {
    id: "sdg-1",
    workspace_id: "ws-a",
    subscription_id: "sub-a",
    plan_id: "plan-a",
    grant_day: "2026-01-15",
    amount: 5_000,
    ledger_entry_id: "led-grant-1",
    created_at: 1,
    ...over,
  };
}

describe("subscription_plans.daily_grant_vnd", () => {
  test("defaults to 0 on legacy-style inserts", async () => {
    await d.insert(subscriptionPlans).values({
      id: "plan-b",
      name: "no grant",
      price_vnd: 50_000,
      credit_per_period_vnd: 50_000,
      period_days: 30,
      active: true,
      created_at: 1,
    });
    const rows = await d
      .select({ daily_grant_vnd: subscriptionPlans.daily_grant_vnd })
      .from(subscriptionPlans);
    expect(rows.find((r) => r.daily_grant_vnd === 0)).toBeTruthy();
  });

  test("rejects a negative grant", async () => {
    const err = await expectReject(
      d.insert(subscriptionPlans).values({
        id: "plan-c",
        name: "bad",
        price_vnd: 50_000,
        credit_per_period_vnd: 50_000,
        period_days: 30,
        daily_grant_vnd: -1,
        active: true,
        created_at: 1,
      }),
    );
    expect(pgErrorCode(err)).toBe("23514");
  });
});

describe("subscription_daily_grants", () => {
  test("accepts a valid grant row and its subscription_daily_grant ledger kind", async () => {
    await d.insert(ledgerEntries).values({
      id: "led-grant-1",
      wallet_id: "wal-a",
      direction: "credit",
      amount: 5_000,
      kind: "subscription_daily_grant",
      balance_after: 105,
      memo: "daily grant 2026-01-15",
      created_at: 1,
    });
    await d.insert(subscriptionDailyGrants).values(grantRow());
    const rows = await d.select().from(subscriptionDailyGrants);
    expect(rows).toHaveLength(1);
  });

  test("rejects a second grant for the same workspace+subscription+day", async () => {
    const err = await expectReject(
      d
        .insert(subscriptionDailyGrants)
        .values(grantRow({ id: "sdg-2", ledger_entry_id: "led-grant-1" })),
    );
    expect(isUniqueViolation(err)).toBe(true);
  });

  test("rejects a malformed grant_day", async () => {
    const err = await expectReject(
      d
        .insert(subscriptionDailyGrants)
        .values(grantRow({ id: "sdg-3", grant_day: "2026-1-5", ledger_entry_id: "led-grant-1" })),
    );
    expect(pgErrorCode(err)).toBe("23514");
  });

  test("rejects a non-positive amount", async () => {
    const err = await expectReject(
      d
        .insert(subscriptionDailyGrants)
        .values(grantRow({ id: "sdg-4", amount: 0, ledger_entry_id: "led-grant-1" })),
    );
    expect(pgErrorCode(err)).toBe("23514");
  });
});
