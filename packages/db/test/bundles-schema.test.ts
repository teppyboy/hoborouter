import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../src/testing";
import { isUniqueViolation } from "../src/errors";
import {
  creditBundles,
  firstTopupBonuses,
  ledgerEntries,
  payments,
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

function walletRow(id: string, workspaceId: string): typeof wallets.$inferInsert {
  return {
    id,
    workspace_id: workspaceId,
    currency: "VND",
    balance: 100,
    reserved: 0,
    version: 0,
    created_at: 1,
  };
}

function bundleRow(id: string): typeof creditBundles.$inferInsert {
  return { id, name: id, price_vnd: 100, credit_vnd: 100, bonus_vnd: 0, active: true, created_at: 1 };
}

function planRow(id: string): typeof subscriptionPlans.$inferInsert {
  return {
    id,
    name: id,
    price_vnd: 100,
    credit_per_period_vnd: 100,
    period_days: 30,
    active: true,
    created_at: 1,
  };
}

function paymentRow(
  id: string,
  over: Partial<typeof payments.$inferInsert> = {},
): typeof payments.$inferInsert {
  return {
    id,
    workspace_id: "ws-b",
    amount: 100,
    status: "succeeded",
    provider: "manual",
    provider_order_code: `po-${id}`,
    created_at: 1,
    ...over,
  };
}

function subscriptionRow(
  id: string,
  over: Partial<typeof subscriptions.$inferInsert> = {},
): typeof subscriptions.$inferInsert {
  return {
    id,
    workspace_id: "ws-b",
    plan_id: "sp-x",
    status: "active",
    current_period_start: 0,
    current_period_end: 30,
    created_at: 1,
    ...over,
  };
}

function ledgerRow(
  id: string,
  over: Partial<typeof ledgerEntries.$inferInsert> = {},
): typeof ledgerEntries.$inferInsert {
  return {
    id,
    wallet_id: "w-b",
    direction: "credit" as const,
    amount: 100,
    kind: "adjustment" as const,
    reservation_id: null,
    original_ledger_entry_id: null,
    payment_id: null,
    balance_after: 200,
    memo: null,
    created_at: 1,
    ...over,
  };
}

/** Drizzle builders are thenable but not Promise instances; wrap rejections. */
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
  await d.insert(workspaces).values(wsRow("ws-b"));
  await d.insert(wallets).values(walletRow("w-b", "ws-b"));
  await d.insert(creditBundles).values(bundleRow("cb-x"));
  await d.insert(subscriptionPlans).values(planRow("sp-x"));
  await d.insert(payments).values(paymentRow("p-base"));
});

afterAll(async () => {
  await t.drop();
});

describe("subscriptions", () => {
  test("rejects a second active subscription per workspace", async () => {
    await d.insert(subscriptions).values(subscriptionRow("s-1"));
    const err = await expectReject(d.insert(subscriptions).values(subscriptionRow("s-2")));
    expect(isUniqueViolation(err)).toBe(true);
  });

  test("allows one active plus a canceled subscription per workspace", async () => {
    await d
      .insert(subscriptions)
      .values(subscriptionRow("s-3", { status: "canceled", current_period_start: 0, current_period_end: 1 }));
    // s-1 above is still active; a canceled row coexists, a second active does not.
    await expectReject(d.insert(subscriptions).values(subscriptionRow("s-4")));
  });
});

describe("payments purchase kind", () => {
  test("rejects both bundle_id and subscription_plan_id set", async () => {
    await expectReject(
      d.insert(payments).values(
        paymentRow("p-both", { bundle_id: "cb-x", subscription_plan_id: "sp-x" }),
      ),
    );
  });

  test("accepts exactly one of bundle_id / subscription_plan_id set", async () => {
    await d.insert(payments).values(paymentRow("p-bundle", { bundle_id: "cb-x" }));
    await d.insert(payments).values(paymentRow("p-plan", { subscription_plan_id: "sp-x" }));
    await d.insert(payments).values(paymentRow("p-plain"));
  });
});

describe("ledger adjustment idempotency (payment_id, memo)", () => {
  test("rejects duplicate adjustment memo per payment", async () => {
    await d
      .insert(ledgerEntries)
      .values(ledgerRow("l-a1", { payment_id: "p-bundle", memo: "bundle bonus" }));
    const err = await expectReject(
      d.insert(ledgerEntries).values(ledgerRow("l-a2", { payment_id: "p-bundle", memo: "bundle bonus" })),
    );
    expect(isUniqueViolation(err)).toBe(true);
  });

  test("allows distinct memos on one payment (bundle bonus + first topup bonus)", async () => {
    await d
      .insert(ledgerEntries)
      .values(ledgerRow("l-a3", { payment_id: "p-bundle", memo: "first topup bonus" }));
    await d
      .insert(ledgerEntries)
      .values(ledgerRow("l-a4", { payment_id: "p-bundle", memo: "subscription credit" }));
  });

  test("allows duplicate memos across different payments", async () => {
    await d
      .insert(ledgerEntries)
      .values(ledgerRow("l-a5", { payment_id: "p-plan", memo: "bundle bonus" }));
  });
});

describe("first_topup_bonuses", () => {
  test("rejects a second bonus row for the same workspace", async () => {
    await d
      .insert(firstTopupBonuses)
      .values({ workspace_id: "ws-b", payment_id: "p-base", ledger_entry_id: "l-a1", amount: 1, created_at: 1 });
    const err = await expectReject(
      d
        .insert(firstTopupBonuses)
        .values({ workspace_id: "ws-b", payment_id: "p-base", ledger_entry_id: "l-a3", amount: 1, created_at: 1 }),
    );
    expect(isUniqueViolation(err)).toBe(true);
  });

  test("rejects amount <= 0", async () => {
    await d.insert(workspaces).values(wsRow("ws-b3"));
    await expectReject(
      d
        .insert(firstTopupBonuses)
        .values({ workspace_id: "ws-b3", payment_id: "p-base", ledger_entry_id: "l-a1", amount: 0, created_at: 1 }),
    );
  });
});
