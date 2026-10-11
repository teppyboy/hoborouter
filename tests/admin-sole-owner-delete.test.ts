// Sole-owner user removal contract (FROZEN against the admin UI consumer
// apps/web/src/pages/admin/users.tsx removeUser()):
// - DELETE /api/v1/admin/users/:id with optional body {confirm?, transfer_to?}.
// - No body / unconfirmed on a sole-owner user -> 409 SOLE_OWNER naming the
//   workspaces (legacy guidance payload).
// - WORKSPACE_FUNDED: any sole-owned workspace wallet with balance>0 or
//   reserved>0 blocks removal with a structured 409. Money rows (wallet,
//   ledger) are never deleted.
// - confirm:true: each sole-owned workspace either physically deletes (when
//   no FK children exist: no members, no keys, no ledger/payments history)
//   or archives (row retained, status 'suspended') when any history FK child
//   remains. Zero-balance wallet WITH ledger history -> archive, never delete.
// - transfer_to: target must be an existing member of every sole-owned
//   workspace and not the removed user; promoted to owner (audited), then the
//   user is removed and the workspace retained. 409 TRANSFER_TARGET_INVALID
//   otherwise.
// The route plugin is mounted standalone here (app.ts registration is the
// integration owner's lane).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { adminExtraRoutes } from "../apps/api/src/routes/admin-extra";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";

const NOW = 1_700_000_000_000;
const ADMIN = "u-admin";
const SOLE = "u-sole";
const FUNDED = "u-funded";
const HIST = "u-hist";
const TRANSFEREE = "u-transferee";
const MEMBER = "u-member";

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

const removeUser = (userId: string, appInstance = app, body?: unknown) =>
  appInstance.handle(
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

// Workspace with owner membership + zero topup wallet (the create-route shape).
async function addWorkspace(wsId: string, ownerId: string, opts?: { balance?: number }) {
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
     values ($1, $2, 'topup', 'VND', $3, 0, 0, $4)`,
    [`w-${wsId}`, wsId, opts?.balance ?? 0, NOW],
  );
}

const errBody = async (res: Response) =>
  (await res.json()) as {
    error: {
      code: string;
      message: string;
      workspaces?: { id: string; name: string }[];
      needs_transfer?: boolean;
    };
  };

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  await addUser(ADMIN, "admin@t.local", true);
  await addUser(TRANSFEREE, "transferee@t.local");
  await addUser(MEMBER, "member@t.local");
  await addUser("u-tr", "tr-owner@t.local");
  await addUser("u-tf", "tf-owner@t.local");
  // Sole owner of an empty, unfunded workspace.
  await addUser(SOLE, "sole@t.local");
  await addWorkspace("ws-sole", SOLE);
  // Sole owner of a workspace with a funded wallet + real ledger history.
  await addUser(FUNDED, "funded@t.local");
  await addWorkspace("ws-funded", FUNDED, { balance: 50_000 });
  await q(
    `insert into ledger_entries (id, wallet_id, direction, amount, kind, balance_after, created_at)
     values ('led-1', 'w-ws-funded', 'credit', 50000, 'topup', 50000, $1)`,
    [NOW],
  );
  // Sole owner of a zero-balance workspace that still has ledger history.
  await addUser(HIST, "hist@t.local");
  await addWorkspace("ws-hist", HIST);
  await q(
    `insert into ledger_entries (id, wallet_id, direction, amount, kind, balance_after, created_at)
     values ('led-h1', 'w-ws-hist', 'credit', 100000, 'topup', 100000, $1),
            ('led-h2', 'w-ws-hist', 'debit', 100000, 'settle', 0, $1)`,
    [NOW],
  );
  await q(`update wallets set balance = 0 where id = 'w-ws-hist'`);
  app = adminExtraRoutes(db, fakeAuth(ADMIN), {});
});

afterAll(async () => {
  await drop();
});

describe("auth", () => {
  test("non-admin gets 403", async () => {
    const nonAdmin = adminExtraRoutes(db, fakeAuth(MEMBER), {});
    const res = await removeUser(SOLE, nonAdmin);
    expect(res.status).toBe(403);
  });
});

describe("sole-owner guard", () => {
  test("unconfirmed remove returns 409 SOLE_OWNER naming the workspaces", async () => {
    const res = await removeUser(SOLE);
    expect(res.status).toBe(409);
    const body = await errBody(res);
    expect(body.error.code).toBe("SOLE_OWNER");
    expect(body.error.workspaces?.map((w) => w.id)).toContain("ws-sole");
  });

  test("confirm with remaining members returns 409 SOLE_OWNER needs_transfer", async () => {
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ('ws-sole', $1, 'member')`,
      [MEMBER],
    );
    const res = await removeUser(SOLE, app, { confirm: true });
    expect(res.status).toBe(409);
    const body = await errBody(res);
    expect(body.error.code).toBe("SOLE_OWNER");
    expect(body.error.needs_transfer).toBe(true);
    await q(`delete from workspace_members where workspace_id = 'ws-sole' and user_id = $1`, [
      MEMBER,
    ]);
  });
});

describe("funded wallet block", () => {
  test("confirm on a funded workspace returns 409 WORKSPACE_FUNDED and deletes no money", async () => {
    const res = await removeUser(FUNDED, app, { confirm: true });
    expect(res.status).toBe(409);
    const body = await errBody(res);
    expect(body.error.code).toBe("WORKSPACE_FUNDED");
    expect(body.error.workspaces?.map((w) => w.id)).toContain("ws-funded");
    // Nothing touched: user, workspace, wallet, ledger all intact.
    expect(await q(`select 1 from users where id = $1`, [FUNDED])).toHaveLength(1);
    expect(await q(`select 1 from workspaces where id = 'ws-funded'`)).toHaveLength(1);
    expect(await q(`select balance from wallets where id = 'w-ws-funded'`)).toEqual([
      { balance: "50000" },
    ]);
    expect(await q(`select 1 from ledger_entries where wallet_id = 'w-ws-funded'`)).toHaveLength(1);
  });
});

describe("confirmed safe removal", () => {
  test("empty sole workspace is physically deleted, user anonymized", async () => {
    const res = await removeUser(SOLE, app, { confirm: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean; deleted?: string[] };
    expect(body.removed).toBe(true);
    expect(body.deleted).toContain("ws-sole");
    expect(await q(`select 1 from workspaces where id = 'ws-sole'`)).toHaveLength(0);
    expect(await q(`select 1 from wallets where workspace_id = 'ws-sole'`)).toHaveLength(0);
    expect(await q(`select 1 from workspace_members where user_id = $1`, [SOLE])).toHaveLength(0);
    // No history rows reference this user (seeds wrote no audits), so the
    // removal path hard-deletes the user row; with history refs it would
    // anonymize instead (covered by removeUserIdentity's existing behavior).
    expect(await q(`select 1 from users where id = $1`, [SOLE])).toHaveLength(0);
  });

  test("zero-balance workspace with ledger history is archived, money rows retained", async () => {
    const res = await removeUser(HIST, app, { confirm: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean; archived?: string[] };
    expect(body.archived).toContain("ws-hist");
    expect(await q(`select status from workspaces where id = 'ws-hist'`)).toEqual([
      { status: "suspended" },
    ]);
    expect(await q(`select balance from wallets where id = 'w-ws-hist'`)).toHaveLength(1);
    expect(await q(`select 1 from ledger_entries where wallet_id = 'w-ws-hist'`)).toHaveLength(2);
    expect(await q(`select 1 from workspace_members where user_id = $1`, [HIST])).toHaveLength(0);
  });
});

describe("ownership transfer", () => {
  test("transfer_to promotes an existing member and retains the workspace", async () => {
    await addWorkspace("ws-tr", "u-tr");
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ('ws-tr', $1, 'member')`,
      [TRANSFEREE],
    );
    const res = await removeUser("u-tr", app, { transfer_to: TRANSFEREE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      removed: boolean;
      transferred?: { workspace_id: string; to: string }[];
    };
    expect(body.transferred).toEqual([{ workspace_id: "ws-tr", to: TRANSFEREE }]);
    expect(
      await q(`select role from workspace_members where workspace_id = 'ws-tr' and user_id = $1`, [
        TRANSFEREE,
      ]),
    ).toEqual([{ role: "owner" }]);
    expect(await q(`select status from workspaces where id = 'ws-tr'`)).toEqual([
      { status: "active" },
    ]);
    // Removed user no longer a member; transfree audit exists.
    expect(await q(`select 1 from workspace_members where user_id = 'u-tr'`)).toHaveLength(0);
    const audits = await q<{ action: string }>(
      `select action from audit_log where action = 'member.role_change' and workspace_id = 'ws-tr'`,
    );
    expect(audits).toHaveLength(1);
  });

  test("transfer target outside the workspace is rejected", async () => {
    await addWorkspace("ws-tf", "u-tf");
    const res = await removeUser("u-tf", app, { transfer_to: MEMBER });
    expect(res.status).toBe(409);
    const body = await errBody(res);
    expect(body.error.code).toBe("TRANSFER_TARGET_INVALID");
    expect(body.error.workspaces?.map((w) => w.id)).toContain("ws-tf");
    // No transfer happened.
    expect(
      await q(`select 1 from workspace_members where workspace_id = 'ws-tf' and user_id = $1`, [
        MEMBER,
      ]),
    ).toHaveLength(0);
  });

  test("transfer_to without a sole-owned workspace is 400", async () => {
    const res = await removeUser(MEMBER, app, { transfer_to: ADMIN });
    expect(res.status).toBe(400);
  });
});
