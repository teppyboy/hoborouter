import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../src/testing";
import { isUniqueViolation, pgErrorCode } from "../src/errors";
import {
  ledgerEntries,
  subscriptionExpiries,
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

function walletRow(
  id: string,
  workspaceId: string,
  over: Partial<typeof wallets.$inferInsert> = {},
): typeof wallets.$inferInsert {
  return {
    id,
    workspace_id: workspaceId,
    currency: "VND",
    balance: 100,
    reserved: 0,
    version: 0,
    created_at: 1,
    ...over,
  };
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
  await d.insert(workspaces).values([wsRow("ws-a"), wsRow("ws-b")]);
});

afterAll(async () => {
  await t.drop();
});

describe("wallets kind", () => {
  test("allows two wallets per workspace with different kinds", async () => {
    await d
      .insert(wallets)
      .values([
        walletRow("w-a-top", "ws-a", { kind: "topup" }),
        walletRow("w-a-sub", "ws-a", { kind: "subscription" }),
      ]);
    const rows = await d.select().from(wallets);
    expect(rows).toHaveLength(2);
  });

  test("rejects duplicate kind per workspace", async () => {
    const err = await expectReject(
      d.insert(wallets).values(walletRow("w-a-dup", "ws-a", { kind: "topup" })),
    );
    expect(isUniqueViolation(err)).toBe(true);
  });

  test("rejects an unknown kind", async () => {
    // The schema's text enum can't type an invalid kind; the DB CHECK is the
    // trust boundary being tested.
    const bad = walletRow("w-b-bad", "ws-b");
    bad.kind = "promo" as unknown as typeof bad.kind;
    const err = await expectReject(d.insert(wallets).values(bad));
    expect(pgErrorCode(err)).toBe("23514");
  });

  test("defaults new rows to topup", async () => {
    await d.insert(wallets).values(walletRow("w-b-top", "ws-b"));
    const rows = await d.select().from(wallets);
    expect(rows.find((r) => r.id === "w-b-top")?.kind).toBe("topup");
  });
});

describe("subscription_plans.rate_limit_per_minute", () => {
  test("defaults to 15", async () => {
    await d
      .insert(subscriptionPlans)
      .values({ id: "sp-d", name: "d", price_vnd: 1, credit_per_period_vnd: 1, created_at: 1 });
    const rows = await d.select().from(subscriptionPlans);
    expect(rows.find((r) => r.id === "sp-d")?.rate_limit_per_minute).toBe(15);
  });

  test("accepts bounds 1 and 600, rejects 0 and 601", async () => {
    await d.insert(subscriptionPlans).values([
      {
        id: "sp-lo",
        name: "lo",
        price_vnd: 1,
        credit_per_period_vnd: 1,
        rate_limit_per_minute: 1,
        created_at: 1,
      },
      {
        id: "sp-hi",
        name: "hi",
        price_vnd: 1,
        credit_per_period_vnd: 1,
        rate_limit_per_minute: 600,
        created_at: 1,
      },
    ]);
    const loErr = await expectReject(
      d.insert(subscriptionPlans).values({
        id: "sp-zero",
        name: "zero",
        price_vnd: 1,
        credit_per_period_vnd: 1,
        rate_limit_per_minute: 0,
        created_at: 1,
      }),
    );
    expect(pgErrorCode(loErr)).toBe("23514");
    const hiErr = await expectReject(
      d.insert(subscriptionPlans).values({
        id: "sp-over",
        name: "over",
        price_vnd: 1,
        credit_per_period_vnd: 1,
        rate_limit_per_minute: 601,
        created_at: 1,
      }),
    );
    expect(pgErrorCode(hiErr)).toBe("23514");
  });
});

describe("subscription_expiries gate", () => {
  test("one row per (subscription, period_end); duplicate rejected", async () => {
    await d.insert(subscriptions).values({
      id: "sub-e",
      workspace_id: "ws-a",
      plan_id: "sp-d",
      status: "active",
      current_period_start: 0,
      current_period_end: 30,
      created_at: 1,
    });
    // Forfeit ledger entries the gate rows point at (FK).
    await d.insert(ledgerEntries).values(
      ["le-1", "le-2", "le-3"].map((id, i) => ({
        id,
        wallet_id: "w-a-sub",
        direction: "debit" as const,
        amount: 10 + i,
        kind: "adjustment" as const,
        balance_after: 90 - i,
        memo: "subscription expired",
        created_at: 1 + i,
      })),
    );
    await d.insert(subscriptionExpiries).values({
      subscription_id: "sub-e",
      period_end: 30,
      ledger_entry_id: "le-1",
      created_at: 1,
    });
    const dup = await expectReject(
      d.insert(subscriptionExpiries).values({
        subscription_id: "sub-e",
        period_end: 30,
        ledger_entry_id: "le-2",
        created_at: 2,
      }),
    );
    expect(isUniqueViolation(dup)).toBe(true);
    // A different period end is a distinct gate.
    await d.insert(subscriptionExpiries).values({
      subscription_id: "sub-e",
      period_end: 60,
      ledger_entry_id: "le-3",
      created_at: 3,
    });
  });
});
