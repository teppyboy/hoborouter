// WORKSPACE_FUNDED 409 payload contract: the structured guard must carry the
// per-blocking-wallet server-locked snapshot (workspace id/name, wallet
// id/kind, balance_vnd, reserved_vnd, available_vnd) so the admin UI can link
// straight to resolution. Legacy fields (id, name) unchanged. Read-only path:
// no wallet/ledger mutation happens when the guard fires.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { adminExtraRoutes } from "../apps/api/src/routes/admin-extra";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";

const NOW = 1_700_000_000_000;
const ADMIN = "u-admin";

let db: Db;
let drop: () => Promise<void>;
let app: ReturnType<typeof adminExtraRoutes>;

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

const removeUser = (userId: string, body?: unknown) =>
  app.handle(
    new Request(`http://t/api/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

async function addUser(id: string, email: string, instanceAdmin = false) {
  await q(
    `insert into users (id, name, email, created_at, updated_at) values ($1, $1, $2, $3, $3)`,
    [id, email, NOW],
  );
  if (instanceAdmin)
    await q(`insert into instance_admins (user_id, created_at) values ($1, $2)`, [id, NOW]);
}

async function addFundedWorkspace(
  wsId: string,
  ownerId: string,
  balance: number,
  reserved: number,
) {
  await q(`insert into workspaces (id, name, status, created_at) values ($1, $1, 'active', $2)`, [
    wsId,
    NOW,
  ]);
  await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [
    wsId,
    ownerId,
  ]);
  await q(
    `insert into wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at)
     values ($1, $2, 'topup', 'VND', $3, $4, 0, $5)`,
    [`w-${wsId}`, wsId, balance, reserved, NOW],
  );
  if (balance > 0) {
    await q(
      `insert into ledger_entries (id, wallet_id, direction, amount, kind, balance_after, created_at)
       values ($1, $2, 'credit', $3, 'topup', $3, $4)`,
      [`led-${wsId}`, `w-${wsId}`, balance, NOW],
    );
  }
}

interface BlockedWallet {
  id: string;
  kind: string;
  balance_vnd: number;
  reserved_vnd: number;
  available_vnd: number;
}

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  await addUser(ADMIN, "admin@t.local", true);
  app = adminExtraRoutes(db, fakeAuth(ADMIN), {});
});

afterAll(async () => {
  await drop();
});

describe("WORKSPACE_FUNDED 409 wallet snapshot", () => {
  test("confirm on funded workspace enriches the 409 with exact locked wallet figures", async () => {
    const user = "u-funded";
    await addUser(user, "funded@t.local");
    await addFundedWorkspace("ws-f1", user, 50_000, 12_000);
    const res = await removeUser(user, { confirm: true });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: {
        code: string;
        workspaces?: { id: string; name: string; wallets: BlockedWallet[] }[];
      };
    };
    expect(body.error.code).toBe("WORKSPACE_FUNDED");
    const ws = body.error.workspaces?.find((w) => w.id === "ws-f1");
    expect(ws?.name).toBe("ws-f1"); // legacy fields unchanged
    expect(ws?.wallets).toEqual([
      {
        id: "w-ws-f1",
        kind: "topup",
        balance_vnd: 50000,
        reserved_vnd: 12000,
        available_vnd: 38000,
      },
    ]);
    for (const v of [
      ws?.wallets[0]?.balance_vnd,
      ws?.wallets[0]?.reserved_vnd,
      ws?.wallets[0]?.available_vnd,
    ]) {
      expect(Number.isSafeInteger(v)).toBe(true);
    }
    // Guard fired before any mutation: money rows intact.
    expect(await q(`select balance, reserved from wallets where id = 'w-ws-f1'`)).toEqual([
      { balance: "50000", reserved: "12000" },
    ]);
    expect(await q(`select 1 from ledger_entries where wallet_id = 'w-ws-f1'`)).toHaveLength(1);
    expect(await q(`select 1 from users where id = $1`, [user])).toHaveLength(1);
  });

  test("unfunded sole-owned workspace is absent from the blocked payload", async () => {
    const user = "u-mixed";
    await addUser(user, "mixed@t.local");
    // Zero-balance wallet WITH ledger history: not funded (no balance, no
    // reservation), so it must NOT appear in the 409 payload even though it
    // blocks physical deletion (archive path).
    await addFundedWorkspace("ws-empty", user, 0, 0);
    await q(
      `insert into ledger_entries (id, wallet_id, direction, amount, kind, balance_after, created_at)
       values ('led-e1', 'w-ws-empty', 'credit', 100000, 'topup', 100000, $1),
              ('led-e2', 'w-ws-empty', 'debit', 100000, 'settle', 0, $1)`,
      [NOW],
    );
    await addFundedWorkspace("ws-f2", user, 1_000, 0);
    const res = await removeUser(user, { confirm: true });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; workspaces?: { id: string; wallets: BlockedWallet[] }[] };
    };
    expect(body.error.code).toBe("WORKSPACE_FUNDED");
    expect(body.error.workspaces?.map((w) => w.id)).toEqual(["ws-f2"]);
  });
});
