import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../src/testing";
import { isUniqueViolation, pgErrorCode } from "../src/errors";
import {
  MAX_SAFE_INTEGER_MONEY,
  adminWalletAdjustments,
  ledgerEntries,
  users,
  wallets,
  workspaces,
} from "../src/schema";

// Admin wallet adjustment receipts: UNIQUE(actor_user_id, idempotency_key)
// arbitrates replays, FKs anchor wallet/workspace/actor/ledger, signed
// non-zero bounded delta, and the persisted receipt fields (balance_before,
// balance_after, reserved, request_payload) round-trip exactly. All behavior
// is tested against a real migrated database, never against SQL text.
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
    kind: "topup",
    balance: 50000,
    reserved: 0,
    version: 0,
    created_at: 1,
  };
}

function receiptRow(
  id: string,
  over: Partial<typeof adminWalletAdjustments.$inferInsert> = {},
): typeof adminWalletAdjustments.$inferInsert {
  return {
    id,
    actor_user_id: "admin-1",
    idempotency_key: `key-${id}-0123456789abcdef`,
    wallet_id: "w-top",
    workspace_id: "ws-a",
    delta: 50000,
    reason: "goodwill credit",
    balance_before: 50000,
    balance_after: 100000,
    reserved: 0,
    ledger_entry_id: null,
    request_payload: { workspaceId: "ws-a", delta: 50000, reason: "goodwill credit" },
    created_at: 1,
    ...over,
  };
}

beforeAll(async () => {
  t = await createTestDb();
  d = t.db;
  await d.insert(users).values({
    id: "admin-1",
    name: "admin",
    email: "admin@example.com",
    createdAt: new Date(1),
    updatedAt: new Date(1),
  });
  await d.insert(workspaces).values(wsRow("ws-a"));
  await d.insert(workspaces).values(wsRow("ws-b"));
  await d.insert(wallets).values(walletRow("w-top", "ws-a"));
  await d.insert(wallets).values(walletRow("w-other", "ws-b"));
});

afterAll(() => t.drop());

test("complete receipt persists all money fields and round-trips exactly", async () => {
  await d.insert(adminWalletAdjustments).values(receiptRow("awa-1"));
  const row = await d.query.adminWalletAdjustments.findFirst({
    where: eq(adminWalletAdjustments.id, "awa-1"),
  });
  expect(row).toMatchObject({
    delta: 50000,
    balance_before: 50000,
    balance_after: 100000,
    reserved: 0,
    reason: "goodwill credit",
    request_payload: { workspaceId: "ws-a", delta: 50000, reason: "goodwill credit" },
    ledger_entry_id: null,
  });
});

test("UNIQUE(actor_user_id, idempotency_key) rejects replay, allows other actors and other keys", async () => {
  await d.insert(users).values({
    id: "admin-2",
    name: "admin2",
    email: "admin2@example.com",
    createdAt: new Date(1),
    updatedAt: new Date(1),
  });
  await d.insert(adminWalletAdjustments).values(receiptRow("awa-2"));
  try {
    // Same actor + same idempotency key = replay, regardless of row id.
    await d
      .insert(adminWalletAdjustments)
      .values(receiptRow("awa-2-dup", { idempotency_key: receiptRow("awa-2").idempotency_key }));
    throw new Error("expected unique violation");
  } catch (e) {
    expect(isUniqueViolation(e)).toBe(true);
  }
  await d.insert(adminWalletAdjustments).values(receiptRow("awa-3", { actor_user_id: "admin-2" }));
  await d
    .insert(adminWalletAdjustments)
    .values(receiptRow("awa-4", { idempotency_key: "key-awa-4-0123456789abcdef" }));
  await d.insert(adminWalletAdjustments).values(receiptRow("awa-3b", { actor_user_id: "admin-2" }));
});

test("delta must be non-zero and bounded by MAX_SAFE_INTEGER_MONEY", async () => {
  try {
    await d.insert(adminWalletAdjustments).values(receiptRow("awa-zero", { delta: 0 }));
    throw new Error("expected check violation");
  } catch (e) {
    expect(pgErrorCode(e)).toBe("23514");
  }
  try {
    await d
      .insert(adminWalletAdjustments)
      .values(receiptRow("awa-huge", { delta: MAX_SAFE_INTEGER_MONEY + 1 }));
    throw new Error("expected check violation");
  } catch (e) {
    expect(pgErrorCode(e)).toBe("23514");
  }
  await d.insert(adminWalletAdjustments).values(receiptRow("awa-debit", { delta: -25000 }));
});

test("FKs reject unknown wallet, workspace, actor, and ledger entries", async () => {
  for (const over of [
    { wallet_id: "w-missing" },
    { workspace_id: "ws-missing" },
    { actor_user_id: "admin-missing" },
    { ledger_entry_id: "led-missing" },
  ] as const) {
    try {
      await d
        .insert(adminWalletAdjustments)
        .values(
          receiptRow(
            `awa-fk-${over.wallet_id ?? over.workspace_id ?? over.actor_user_id ?? over.ledger_entry_id}`,
            over,
          ),
        );
      throw new Error("expected FK violation");
    } catch (e) {
      expect(pgErrorCode(e)).toBe("23503");
    }
  }
});

test("ledger_entry_id accepts a real ledger row within the same transaction", async () => {
  await d.transaction(async (tx) => {
    const [led] = await tx
      .insert(ledgerEntries)
      .values({
        id: "led-1",
        wallet_id: "w-top",
        direction: "credit",
        amount: 50000,
        kind: "adjustment",
        balance_after: 100000,
        memo: "Admin adjustment",
        created_at: 1,
      })
      .returning();
    if (!led) throw new Error("ledger insert returned no row");
    await tx
      .insert(adminWalletAdjustments)
      .values(receiptRow("awa-led", { ledger_entry_id: led.id }));
  });
  const row = await d.query.adminWalletAdjustments.findFirst({
    where: eq(adminWalletAdjustments.id, "awa-led"),
  });
  expect(row?.ledger_entry_id).toBe("led-1");
});

test("any failure inside the transaction rolls back receipt, ledger, and wallet writes together", async () => {
  try {
    await d.transaction(async (tx) => {
      await tx.insert(adminWalletAdjustments).values(receiptRow("awa-rb"));
      await tx.insert(ledgerEntries).values({
        id: "led-rb",
        wallet_id: "w-top",
        direction: "credit",
        amount: 50000,
        kind: "adjustment",
        balance_after: 100000,
        created_at: 1,
      });
      throw new Error("simulated audit failure");
    });
    throw new Error("expected transaction to abort");
  } catch (e) {
    expect((e as Error).message).toBe("simulated audit failure");
  }
  const receipt = await d.query.adminWalletAdjustments.findFirst({
    where: eq(adminWalletAdjustments.id, "awa-rb"),
  });
  const ledger = await d.query.ledgerEntries.findFirst({
    where: eq(ledgerEntries.id, "led-rb"),
  });
  expect(receipt).toBeUndefined();
  expect(ledger).toBeUndefined();
});
