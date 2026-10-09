// Admin wallet adjustment API contract (FROZEN against the admin UI consumer
// apps/web/src/pages/admin/users.tsx):
// - POST /api/v1/admin/workspaces/:workspaceId/wallet/adjust
//     { delta, reason, idempotencyKey } -> AdjustReceipt JSON directly
//     { ledgerEntryId, balanceBefore, balanceAfter, reserved, workspaceId,
//       replayed }
//     Explicit topup-wallet resolution per workspace; instance-admin only.
//     Replay with the same (actor, key) returns the ORIGINAL receipt; a
//     different payload is 409 IDEMPOTENCY_MISMATCH.
// - GET /api/v1/admin/users/:userId/context
//     -> { memberships: [{workspaceId, workspaceName, role}],
//          wallets: [{workspaceId, kind: "topup", balance, reserved}] }
//     Read-only; never exposes subscription wallets or other users.
// The route plugin is mounted standalone here (app.ts registration is the
// integration owner's lane).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import {
  adminWalletAdjustRoutes,
  type AdminWalletAdjustApp,
} from "../apps/api/src/routes/admin-wallet-adjust";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";

const NOW = 1_700_000_000_000;
const ADMIN = "admin-user";
const MEMBER = "member-user";

let db: Db;
let drop: () => Promise<void>;
let adminApp: AdminWalletAdjustApp;
let memberApp: AdminWalletAdjustApp;

const fakeAuth = (userId: string): BetterAuthInstance =>
  ({
    handler: async () => new Response(null, { status: 404 }),
    api: {
      getSession: async () => ({
        user: { id: userId },
        session: { id: `sess-${userId}`, userId },
      }),
    },
  }) as unknown as BetterAuthInstance;

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.$client.unsafe(text, params as never[])) as T[];
}

const ADJUST_BODY = {
  delta: 250_000,
  reason: "manual correction",
  idempotencyKey: "api-key-0123456789012345678",
};

const adjust = (workspaceId: string, body: unknown, app: AdminWalletAdjustApp) =>
  app.handle(
    new Request(`http://t/api/v1/admin/workspaces/${workspaceId}/wallet/adjust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const context = (userId: string, app: AdminWalletAdjustApp) =>
  app.handle(new Request(`http://t/api/v1/admin/users/${userId}/context`));

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  await q(
    `insert into users (id, name, email, created_at, updated_at) values
     ($1, 'Admin', 'admin@t.local', $3, $3), ($2, 'Member', 'member@t.local', $3, $3)`,
    [ADMIN, MEMBER, NOW],
  );
  await q(`insert into instance_admins (user_id, created_at) values ($1, $2)`, [ADMIN, NOW]);
  await q(
    `insert into workspaces (id, name, status, created_at) values ('ws-a', 'A', 'active', $1)`,
    [NOW],
  );
  await q(
    `insert into wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
     values ('wal-a', 'ws-a', 'VND', 'topup', 0, 0, 0, $1)`,
    [NOW],
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ('ws-a', $1, 'owner')`,
    [MEMBER],
  );
  // The route factory IS a mounted Elysia instance (no app.ts registration;
  // the integration owner registers adminWalletAdjustRoutes later).
  adminApp = adminWalletAdjustRoutes(db, fakeAuth(ADMIN));
  memberApp = adminWalletAdjustRoutes(db, fakeAuth(MEMBER));
});

afterAll(async () => {
  await drop();
});

describe("POST /api/v1/admin/workspaces/:workspaceId/wallet/adjust", () => {
  test("non-instance-admin is 403, nothing written", async () => {
    const res = await adjust("ws-a", ADJUST_BODY, memberApp);
    expect(res.status).toBe(403);
    const rows = await q<{ n: number }>(`select count(*)::int as n from admin_wallet_adjustments`);
    expect(rows[0]!.n).toBe(0);
  });

  test("admin adjust credits the topup wallet and returns the UI receipt envelope", async () => {
    const res = await adjust("ws-a", ADJUST_BODY, adminApp);
    expect(res.status).toBe(200);
    const receipt = (await res.json()) as Record<string, unknown>;
    expect(receipt.workspaceId).toBe("ws-a");
    expect(receipt.balanceBefore).toBe(0);
    expect(receipt.balanceAfter).toBe(250_000);
    expect(receipt.reserved).toBe(0);
    expect(receipt.replayed).toBe(false);
    expect(typeof receipt.ledgerEntryId).toBe("string");
    const wallet = await q<{ balance: number }>(
      `select balance::int from wallets where id = 'wal-a'`,
    );
    expect(wallet[0]!.balance).toBe(250_000);
    const audit = await q<{ action: string; actor_user_id: string }>(
      `select action, actor_user_id from audit_log where target = 'wal-a'`,
    );
    expect(audit[0]!.action).toBe("admin.wallet.adjust");
    expect(audit[0]!.actor_user_id).toBe(ADMIN);
  });

  test("replay with same actor+key returns the ORIGINAL receipt, no double credit", async () => {
    const first = await adjust("ws-a", ADJUST_BODY, adminApp);
    expect(first.status).toBe(200);
    const a = (await first.json()) as Record<string, unknown>;
    const second = await adjust("ws-a", ADJUST_BODY, adminApp);
    expect(second.status).toBe(200);
    const b = (await second.json()) as Record<string, unknown>;
    expect(b.ledgerEntryId).toBe(a.ledgerEntryId);
    expect(b.balanceAfter).toBe(a.balanceAfter);
    expect(b.replayed).toBe(true);
    const wallet = await q<{ balance: number }>(
      `select balance::int from wallets where id = 'wal-a'`,
    );
    expect(wallet[0]!.balance).toBe(250_000);
  });

  test("replay with different delta/reason is 409 IDEMPOTENCY_MISMATCH", async () => {
    const res = await adjust("ws-a", { ...ADJUST_BODY, delta: 1 }, adminApp);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  test("unknown workspace (no topup wallet) is 404", async () => {
    const res = await adjust("ws-none", ADJUST_BODY, adminApp);
    expect(res.status).toBe(404);
  });

  test("subscription-only workspace is unreachable (404, no topup wallet)", async () => {
    await q(
      `insert into workspaces (id, name, status, created_at) values ('ws-sub', 'S', 'active', $1)`,
      [NOW],
    );
    await q(
      `insert into wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
       values ('wal-sub', 'ws-sub', 'VND', 'subscription', 0, 0, 0, $1)`,
      [NOW],
    );
    const res = await adjust("ws-sub", ADJUST_BODY, adminApp);
    expect(res.status).toBe(404);
  });

  test("delta 0 rejected as 400 before any write", async () => {
    const res = await adjust(
      "ws-a",
      { ...ADJUST_BODY, idempotencyKey: "delta-zero-012345678901", delta: 0 },
      adminApp,
    );
    expect(res.status).toBe(400);
  });

  test("debit below reserved is 409 INSUFFICIENT", async () => {
    await q(`update wallets set reserved = 100_000 where id = 'wal-a'`);
    const res = await adjust(
      "ws-a",
      { ...ADJUST_BODY, idempotencyKey: "insufficient-01234567", delta: -250_000 },
      adminApp,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INSUFFICIENT");
    await q(`update wallets set reserved = 0 where id = 'wal-a'`);
  });

  test("resulting balance over maximum is 409 OVERFLOW", async () => {
    const MAX = 9_007_199_254_740_991;
    await q(
      `insert into workspaces (id, name, status, created_at) values ('ws-ovf', 'O', 'active', $1)`,
      [NOW],
    );
    await q(
      `insert into wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
       values ('wal-ovf', 'ws-ovf', 'VND', 'topup', $2, 0, 0, $1)`,
      [NOW, MAX - 5],
    );
    const res = await adjust(
      "ws-ovf",
      { ...ADJUST_BODY, idempotencyKey: "overflow-key-012345678", delta: 100 },
      adminApp,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("OVERFLOW");
  });
});

describe("GET /api/v1/admin/users/:userId/context", () => {
  test("returns separate memberships + wallets arrays, read-only", async () => {
    const before = await q<{ balance: number }>(
      `select balance::int from wallets where id = 'wal-a'`,
    );
    const res = await context(MEMBER, adminApp);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      memberships: Array<{ workspaceId: string; workspaceName: string; role: string }>;
      wallets: Array<{ workspaceId: string; kind: string; balance: number; reserved: number }>;
    };
    expect(body.memberships).toEqual([{ workspaceId: "ws-a", workspaceName: "A", role: "owner" }]);
    expect(body.wallets).toEqual([
      { workspaceId: "ws-a", kind: "topup", balance: before[0]!.balance, reserved: 0 },
    ]);
    const after = await q<{ balance: number }>(
      `select balance::int from wallets where id = 'wal-a'`,
    );
    expect(after[0]!.balance).toBe(before[0]!.balance);
  });

  test("user without memberships returns empty arrays", async () => {
    const res = await context(ADMIN, adminApp);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memberships: unknown[]; wallets: unknown[] };
    expect(body.memberships).toEqual([]);
    expect(body.wallets).toEqual([]);
  });

  test("unknown user is 404; non-admin is 403", async () => {
    expect((await context("ghost", adminApp)).status).toBe(404);
    expect((await context(ADMIN, memberApp)).status).toBe(403);
  });
});
