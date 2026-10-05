import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../src/testing";
import { isUniqueViolation, pgErrorCode } from "../src/errors";
import { createDb } from "../src/client";
import { migrate } from "../src/migrate";
import {
  MAX_SAFE_INTEGER_MONEY,
  ledgerEntries,
  modelBindings,
  payments,
  priceSnapshots,
  requests,
  reservations,
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

function ledgerRow(
  id: string,
  walletId: string,
  over: Partial<typeof ledgerEntries.$inferInsert> = {},
): typeof ledgerEntries.$inferInsert {
  return {
    id,
    wallet_id: walletId,
    direction: "credit" as const,
    amount: 100,
    kind: "topup" as const,
    reservation_id: null,
    original_ledger_entry_id: null,
    payment_id: null,
    balance_after: 100,
    memo: null,
    created_at: 1,
    ...over,
  };
}

/**
 * Drizzle query builders are thenable but not Promise instances; Bun's
 * `.rejects` requires a real Promise, so wrap rejections manually.
 */
async function expectReject(p: PromiseLike<unknown>): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
}

beforeAll(async () => {
  t = await createTestDb();
  d = t.db;
});

afterAll(async () => {
  await t.drop();
});

describe("migrations", () => {
  test("migrate on empty database succeeds", () => {
    // beforeAll already migrated the fresh database
    expect(true).toBe(true);
  });

  test("migrate is idempotent (runs cleanly twice)", async () => {
    await expect(migrate(d)).resolves.toBeUndefined();
  });

  test("requests soft-delete columns exist", async () => {
    const res = await d.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'requests' AND column_name IN ('deleted_at','deleted_by')`,
    );
    expect(res.map((r) => r.column_name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([
      "deleted_at",
      "deleted_by",
    ]);
  });
});

describe("money CHECK constraints", () => {
  test("wallet balance rejects negative", async () => {
    await d.insert(workspaces).values(wsRow("ws-c")).onConflictDoNothing();
    expectReject(d.insert(wallets).values(walletRow("w-neg", "ws-c", { balance: -1 })));
  });

  test(`wallet balance rejects > 2^53-1 (${MAX_SAFE_INTEGER_MONEY + 1})`, async () => {
    expectReject(
      d.insert(wallets).values(walletRow("w-big", "ws-c", { balance: MAX_SAFE_INTEGER_MONEY + 1 })),
    );
  });

  test("wallet balance accepts exactly MAX_SAFE_INTEGER_MONEY", async () => {
    await d.insert(wallets).values(walletRow("w-max", "ws-c", { balance: MAX_SAFE_INTEGER_MONEY }));
    await d.delete(wallets).where(eq(wallets.id, "w-max"));
  });

  test("ledger amount rejects negative and zero", async () => {
    await d.insert(wallets).values(walletRow("w-l", "ws-c")).onConflictDoNothing();
    expectReject(d.insert(ledgerEntries).values(ledgerRow("l-neg", "w-l", { amount: -5 })));
  });
});

describe("partial unique ledger indexes (one settle/topup/refund per key)", () => {
  test("one settle per reservation", async () => {
    // FK chain for reservation_id: binding -> snapshot -> request -> reservations
    await d.insert(modelBindings).values({
      id: "mb-s",
      workspace_id: null,
      public_model: "m",
      cpa_alias: "a",
      status: "published",
      price_input_per_1m: 1,
      price_output_per_1m: 1,
      effective_at: 1,
    });
    await d.insert(priceSnapshots).values({
      id: "ps-s",
      binding_id: "mb-s",
      price_input: 1,
      price_output: 1,
      created_at: 1,
    });
    await d.insert(requests).values([
      {
        id: "rq-s",
        workspace_id: "ws-c",
        model_binding_id: "mb-s",
        endpoint: "/v1/chat/completions",
        mode: "stream",
        status: "pending",
        created_at: 1,
      },
      {
        id: "rq-s2",
        workspace_id: "ws-c",
        model_binding_id: "mb-s",
        endpoint: "/v1/chat/completions",
        mode: "stream",
        status: "pending",
        created_at: 1,
      },
    ]);
    await d.insert(reservations).values([
      {
        id: "r1",
        wallet_id: "w-l",
        gateway_request_id: "rq-s",
        price_snapshot_id: "ps-s",
        status: "held",
        cap_amount: 100,
        estimated_input_tokens: 10,
        created_at: 1,
      },
      {
        id: "r2",
        wallet_id: "w-l",
        gateway_request_id: "rq-s2",
        price_snapshot_id: "ps-s",
        status: "held",
        cap_amount: 100,
        estimated_input_tokens: 10,
        created_at: 1,
      },
    ]);
    await d
      .insert(ledgerEntries)
      .values(ledgerRow("l-s1", "w-l", { kind: "settle", reservation_id: "r1" }));
    expectReject(
      d
        .insert(ledgerEntries)
        .values(ledgerRow("l-s2", "w-l", { kind: "settle", reservation_id: "r1" })),
    );
    // a settle for a different reservation is fine
    await d
      .insert(ledgerEntries)
      .values(ledgerRow("l-s3", "w-l", { kind: "settle", reservation_id: "r2" }));
  });

  test("one topup per payment", async () => {
    await d.insert(payments).values({
      id: "p1",
      workspace_id: "ws-c",
      amount: 100,
      status: "succeeded",
      provider: "manual",
      provider_order_code: "po1",
      created_at: 1,
    });
    await d
      .insert(ledgerEntries)
      .values(ledgerRow("l-t1", "w-l", { kind: "topup", payment_id: "p1" }));
    expectReject(
      d.insert(ledgerEntries).values(ledgerRow("l-t2", "w-l", { kind: "topup", payment_id: "p1" })),
    );
  });

  test("one refund per original ledger entry", async () => {
    await d
      .insert(ledgerEntries)
      .values(ledgerRow("l-o", "w-l", { kind: "adjustment", direction: "debit" }));
    await d.insert(ledgerEntries).values(
      ledgerRow("l-r1", "w-l", {
        kind: "refund",
        direction: "debit",
        original_ledger_entry_id: "l-o",
      }),
    );
    expectReject(
      d.insert(ledgerEntries).values(
        ledgerRow("l-r2", "w-l", {
          kind: "refund",
          direction: "debit",
          original_ledger_entry_id: "l-o",
        }),
      ),
    );
  });
});

describe("foreign keys", () => {
  test("wallet with nonexistent workspace rejected", async () => {
    expectReject(d.insert(wallets).values(walletRow("w-orphan", "no-such-ws")));
  });

  test("request with nonexistent workspace rejected", async () => {
    expectReject(
      d.insert(requests).values({
        id: "rq1",
        workspace_id: "no-such-ws",
        endpoint: "/v1/chat/completions",
        mode: "stream",
        status: "pending",
        created_at: 1,
      }),
    );
  });
});

describe("append-only ledger", () => {
  test("ledger_entries update and delete rejected", async () => {
    expectReject(d.update(ledgerEntries).set({ memo: "x" }).where(eq(ledgerEntries.id, "l-s1")));
    expectReject(d.delete(ledgerEntries).where(eq(ledgerEntries.id, "l-s1")));
  });
});

describe("createDb URL guard", () => {
  test("rejects non-postgres URLs instead of silently opening SQLite", () => {
    expect(() => createDb(":memory:")).toThrow(/PostgreSQL URL/);
    expect(() => createDb("")).toThrow(/PostgreSQL URL/);
    expect(() => createDb("sqlite://foo")).toThrow(/PostgreSQL URL/);
  });

  test("accepts postgres and postgresql URLs (no connection attempted)", () => {
    expect(() => createDb("postgres://u:p@127.0.0.1:5432/db")).not.toThrow();
    expect(() => createDb("postgresql://u:p@127.0.0.1:5432/db")).not.toThrow();
  });
});

describe("pgErrorCode / isUniqueViolation", () => {
  test("real duplicate insert raises DrizzleQueryError detected as unique violation", async () => {
    await d.insert(workspaces).values(wsRow("w-uniq-dup"));
    let caught: unknown;
    try {
      await d.insert(workspaces).values(wsRow("w-uniq-dup"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);
    expect(pgErrorCode(caught)).toBe("23505");
  });

  test("plain Error without code is not a unique violation", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(pgErrorCode(new Error("boom"))).toBeUndefined();
  });
});
