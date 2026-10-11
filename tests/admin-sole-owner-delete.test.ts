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
import { membersRoutes } from "../apps/api/src/routes/members";
import { keysRoutes } from "../apps/api/src/routes/keys";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";

const NOW = 1_700_000_000_000;
const ADMIN = "u-admin";
const TRANSFEREE = "u-transferee";
const MEMBER = "u-member";

let db: Db;
let drop: () => Promise<void>;
let tUrl: string;
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

// Deterministic per-test fixtures: unique user/workspace/wallet ids so test
// order can never matter (no shared fixtures mutated by earlier tests).
let seq = 0;
async function seedSole(opts?: { balance?: number; ledger?: "funded" | "history" | "none" }) {
  const n = ++seq;
  const user = `u-s${n}`;
  const ws = `ws-s${n}`;
  const wallet = `w-${ws}`;
  await addUser(user, `${user}@t.local`);
  await addWorkspace(ws, user, { balance: opts?.balance ?? 0 });
  if (opts?.ledger === "funded") {
    await q(
      `insert into ledger_entries (id, wallet_id, direction, amount, kind, balance_after, created_at)
       values ($1, $2, 'credit', 50000, 'topup', 50000, $3)`,
      [`led-${ws}`, wallet, NOW],
    );
  } else if (opts?.ledger === "history") {
    await q(
      `insert into ledger_entries (id, wallet_id, direction, amount, kind, balance_after, created_at)
       values ($1, $2, 'credit', 100000, 'topup', 100000, $4),
              ($3, $2, 'debit', 100000, 'settle', 0, $4)`,
      [`led-${ws}-a`, wallet, `led-${ws}-b`, NOW],
    );
    await q(`update wallets set balance = 0 where id = $1`, [wallet]);
  }
  return { user, ws, wallet };
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
  tUrl = t.url;
  await addUser(ADMIN, "admin@t.local", true);
  await addUser(TRANSFEREE, "transferee@t.local");
  await addUser(MEMBER, "member@t.local");
  await addUser("u-tr", "tr-owner@t.local");
  await addUser("u-tf", "tf-owner@t.local");
  await addUser("u-ao", "ao@t.local");
  await addUser("u-af", "af@t.local");
  app = adminExtraRoutes(db, fakeAuth(ADMIN), {});
});

afterAll(async () => {
  await drop();
});

describe("auth", () => {
  test("non-admin gets 403", async () => {
    const { user } = await seedSole();
    const nonAdmin = adminExtraRoutes(db, fakeAuth(MEMBER), {});
    const res = await removeUser(user, nonAdmin);
    expect(res.status).toBe(403);
  });
});

describe("sole-owner guard", () => {
  test("unconfirmed remove returns 409 SOLE_OWNER naming the workspaces", async () => {
    const { user, ws } = await seedSole();
    const res = await removeUser(user);
    expect(res.status).toBe(409);
    const body = await errBody(res);
    expect(body.error.code).toBe("SOLE_OWNER");
    expect(body.error.workspaces?.map((w) => w.id)).toContain(ws);
  });

  test("confirm with remaining members returns 409 SOLE_OWNER needs_transfer", async () => {
    const { user, ws } = await seedSole();
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')`,
      [ws, MEMBER],
    );
    const res = await removeUser(user, app, { confirm: true });
    expect(res.status).toBe(409);
    const body = await errBody(res);
    expect(body.error.code).toBe("SOLE_OWNER");
    expect(body.error.needs_transfer).toBe(true);
  });
});

describe("funded wallet block", () => {
  test("confirm on a funded workspace returns 409 WORKSPACE_FUNDED and deletes no money", async () => {
    const { user, ws, wallet } = await seedSole({ balance: 50_000, ledger: "funded" });
    const res = await removeUser(user, app, { confirm: true });
    expect(res.status).toBe(409);
    const body = await errBody(res);
    expect(body.error.code).toBe("WORKSPACE_FUNDED");
    expect(body.error.workspaces?.map((w) => w.id)).toContain(ws);
    // Nothing touched: user, workspace, wallet, ledger all intact.
    expect(await q(`select 1 from users where id = $1`, [user])).toHaveLength(1);
    expect(await q(`select 1 from workspaces where id = $1`, [ws])).toHaveLength(1);
    expect(await q(`select balance from wallets where id = $1`, [wallet])).toEqual([
      { balance: "50000" },
    ]);
    expect(await q(`select 1 from ledger_entries where wallet_id = $1`, [wallet])).toHaveLength(1);
  });
});

describe("confirmed safe removal", () => {
  test("empty sole workspace is physically deleted, user hard-deleted (no history refs)", async () => {
    const { user, ws } = await seedSole();
    const res = await removeUser(user, app, { confirm: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean; deleted?: string[] };
    expect(body.removed).toBe(true);
    expect(body.deleted).toContain(ws);
    expect(await q(`select 1 from workspaces where id = $1`, [ws])).toHaveLength(0);
    expect(await q(`select 1 from wallets where workspace_id = $1`, [ws])).toHaveLength(0);
    expect(await q(`select 1 from workspace_members where user_id = $1`, [user])).toHaveLength(0);
    // No history rows reference this user (seeds wrote no audits), so the
    // removal path hard-deletes the user row; with history refs it would
    // tombstone instead (covered by the chat-history test below).
    expect(await q(`select 1 from users where id = $1`, [user])).toHaveLength(0);
  });

  test("zero-balance workspace with ledger history is archived, money rows retained", async () => {
    const { user, ws, wallet } = await seedSole({ ledger: "history" });
    const res = await removeUser(user, app, { confirm: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean; archived?: string[] };
    expect(body.archived).toContain(ws);
    expect(await q(`select status from workspaces where id = $1`, [ws])).toEqual([
      { status: "suspended" },
    ]);
    expect(await q(`select 1 from wallets where id = $1`, [wallet])).toHaveLength(1);
    expect(await q(`select 1 from ledger_entries where wallet_id = $1`, [wallet])).toHaveLength(2);
    expect(await q(`select 1 from workspace_members where user_id = $1`, [user])).toHaveLength(0);
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

describe("all-or-nothing validation", () => {
  test("multi-workspace confirm with a later blocker leaves every workspace unchanged", async () => {
    // Regression: the old loop deleted/archived ws-ao1 before hitting the
    // blocker on ws-ao2 and returned 409 with the partial commit in place.
    await addWorkspace("ws-ao1", "u-ao");
    await addWorkspace("ws-ao2", "u-ao");
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ('ws-ao2', $1, 'member')`,
      [MEMBER],
    );
    const res = await removeUser("u-ao", app, { confirm: true });
    expect(res.status).toBe(409);
    const body = await errBody(res);
    expect(body.error.needs_transfer).toBe(true);
    // NOTHING mutated: both workspaces, wallets, memberships, user intact.
    expect(await q(`select 1 from workspaces where id = 'ws-ao1'`)).toHaveLength(1);
    expect(await q(`select 1 from workspaces where id = 'ws-ao2'`)).toHaveLength(1);
    expect(await q(`select 1 from wallets where workspace_id = 'ws-ao1'`)).toHaveLength(1);
    expect(await q(`select 1 from workspace_members where user_id = 'u-ao'`)).toHaveLength(2);
  });

  test("multi-workspace funded blocker leaves the deletable workspace unchanged", async () => {
    await addWorkspace("ws-af1", "u-af");
    await addWorkspace("ws-af2", "u-af", { balance: 1000 });
    const res = await removeUser("u-af", app, { confirm: true });
    expect(res.status).toBe(409);
    const body = await errBody(res);
    expect(body.error.code).toBe("WORKSPACE_FUNDED");
    expect(body.error.workspaces?.map((w) => w.id)).toEqual(["ws-af2"]);
    expect(await q(`select 1 from workspaces where id = 'ws-af1'`)).toHaveLength(1);
    expect(await q(`select 1 from workspace_members where user_id = 'u-af'`)).toHaveLength(2);
  });

  test("strict body parsing: malformed JSON, wrong types, unknown keys are 400", async () => {
    const { user } = await seedSole();
    const bad = async (raw: string) =>
      app.handle(
        new Request(`http://t/api/v1/admin/users/${user}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: raw,
        }),
      );
    expect((await bad("not json")).status).toBe(400);
    expect((await bad(JSON.stringify({ confirm: "yes" }))).status).toBe(400);
    expect((await bad(JSON.stringify({ unknown: 1 }))).status).toBe(400);
    expect((await bad(JSON.stringify({ confirm: true, transfer_to: "" }))).status).toBe(400);
    // absent body stays legacy (409 SOLE_OWNER, not 400)
    expect((await removeUser(user)).status).toBe(409);
  });

  test("audit failure rolls back the entire removal", async () => {
    await addUser("u-aur", "aur@t.local");
    await addWorkspace("ws-aur", "u-aur");
    await q(
      `create or replace function block_user_remove() returns trigger as $$
       begin
         if new.action = 'user.remove' then
           raise exception 'audit sink down';
         end if;
         return new;
       end; $$ language plpgsql`,
    );
    await q(
      `create trigger audit_block before insert on audit_log for each row execute function block_user_remove()`,
    );
    try {
      const res = await removeUser("u-aur", app, { confirm: true });
      expect(res.status).toBe(500);
      // Nothing committed: user, workspace, wallet, membership all intact.
      expect(await q(`select 1 from users where id = 'u-aur'`)).toHaveLength(1);
      expect(await q(`select 1 from workspaces where id = 'ws-aur'`)).toHaveLength(1);
      expect(await q(`select 1 from wallets where workspace_id = 'ws-aur'`)).toHaveLength(1);
      expect(await q(`select 1 from workspace_members where user_id = 'u-aur'`)).toHaveLength(1);
    } finally {
      await q(`drop trigger audit_block on audit_log`);
      await q(`drop function block_user_remove()`);
    }
  });

  test("non-FK error in the mutation phase propagates and rolls back atomically", async () => {
    await addUser("u-awf", "awf@t.local");
    await addWorkspace("ws-awf", "u-awf");
    await q(
      `insert into ledger_entries (id, wallet_id, direction, amount, kind, balance_after, created_at)
       values ('led-awf', 'w-ws-awf', 'credit', 1000, 'adjustment', 1000, $1)`,
      [NOW],
    );
    // Force a NON-FK error during the archive fallback: the workspace-status
    // update raises a check violation (23514), which must NOT be swallowed as
    // an archive and must roll the whole transaction back.
    await q(
      `create or replace function block_archive() returns trigger as $$
       begin
         if new.status = 'suspended' then
           raise exception 'boom' using errcode = 'check_violation';
         end if;
         return new;
       end; $$ language plpgsql`,
    );
    await q(
      `create trigger archive_block before update on workspaces for each row execute function block_archive()`,
    );
    try {
      let status = 0;
      try {
        const res = await removeUser("u-awf", app, { confirm: true });
        status = res.status;
      } catch {
        status = 500; // unhandled throw also means rollback
      }
      expect([500, 0]).toContain(status === 0 ? 500 : status); // never a 2xx/4xx success path
      // Atomic: workspace retained (not archived, not deleted), ledger intact,
      // user intact.
      expect(await q(`select status from workspaces where id = 'ws-awf'`)).toEqual([
        { status: "active" },
      ]);
      expect(await q(`select 1 from ledger_entries where wallet_id = 'w-ws-awf'`)).toHaveLength(1);
      expect(await q(`select 1 from users where id = 'u-awf'`)).toHaveLength(1);
    } finally {
      await q(`drop trigger archive_block on workspaces`);
      await q(`drop function block_archive()`);
    }
  });

  test("chat history is retained and the identity tombstoned (no hard delete)", async () => {
    await addUser("u-chat", "chat@t.local");
    await addWorkspace("ws-chat", "u-chat");
    await q(
      `insert into chat_conversations (id, user_id, workspace_id, title, messages, created_at, updated_at)
       values ('cc-1', 'u-chat', 'ws-chat', 't', '[]'::jsonb, $1, $1)`,
      [NOW],
    );
    const res = await removeUser("u-chat", app, { confirm: true });
    expect(res.status).toBe(200);
    // Tombstone: no FK-eligible hard delete because chat history references it.
    const u = await q<{ email: string; name: string }>(
      `select email, name from users where id = 'u-chat'`,
    );
    expect(u).toHaveLength(1);
    expect(u[0]!.email).toBe("deleted+u-chat@invalid");
    expect(u[0]!.name).toBe("Deleted user");
    expect(await q(`select 1 from chat_conversations where id = 'cc-1'`)).toHaveLength(1);
    // Identity disabled: sessions and accounts gone.
    expect(await q(`select 1 from session where user_id = 'u-chat'`)).toHaveLength(0);
    expect(await q(`select 1 from "account" where user_id = 'u-chat'`)).toHaveLength(0);
    expect(await q(`select 1 from workspace_members where user_id = 'u-chat'`)).toHaveLength(0);
  });

  test("zero-balance wallet is locked: a held wallet row blocks the confirm removal", async () => {
    await addUser("u-zl", "zl@t.local");
    await addWorkspace("ws-zl", "u-zl");
    const { SQL } = await import("bun");
    const attacker = new SQL(tUrl, { max: 1 });
    try {
      await attacker.unsafe(`begin`);
      await attacker.unsafe(`select * from wallets where workspace_id = 'ws-zl' for update`);
      let settled = false;
      const route = removeUser("u-zl", app, { confirm: true }).then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(settled).toBe(false); // blocked: zero wallet was FOR UPDATE-locked
      await attacker.unsafe(`commit`);
      await route;
      expect(settled).toBe(true);
      expect(await q(`select 1 from workspaces where id = 'ws-zl'`)).toHaveLength(0);
    } finally {
      try {
        await attacker.unsafe(`rollback`);
      } catch {
        // already committed
      }
      attacker.close();
    }
  });
});

describe("lock-protocol concurrency regressions", () => {
  const holdAndRun = async (
    work: (rsv: { unsafe: (q: string) => Promise<unknown>; release: () => void }) => Promise<void>,
  ) => {
    const { SQL } = await import("bun");
    const raw = new SQL(tUrl, { max: 1 });
    const rsv = await raw.reserve();
    try {
      await work(
        rsv as unknown as {
          unsafe: (q: string, p?: unknown[]) => Promise<unknown>;
          release: () => void;
        },
      );
    } finally {
      rsv.release();
      raw.close();
    }
  };

  test("transfer promotion serializes on the target membership row", async () => {
    await addUser("u-yo", "yo@t.local");
    await addWorkspace("ws-yo", "u-yo");
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ('ws-yo', $1, 'member')`,
      [TRANSFEREE],
    );
    await holdAndRun(async (rsv) => {
      await rsv.unsafe(`begin`);
      // Hold exactly the membership row the promotion must update.
      await rsv.unsafe(
        `select * from workspace_members where workspace_id = 'ws-yo' and user_id = '${TRANSFEREE}' for update`,
      );
      let settled = false;
      const route = removeUser("u-yo", app, { transfer_to: TRANSFEREE }).then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // blocked on the membership row lock
      await rsv.unsafe(`rollback`);
      await route;
      expect(settled).toBe(true);
    });
    const role = await q<{ role: string }>(
      `select role from workspace_members where workspace_id = 'ws-yo' and user_id = $1`,
      [TRANSFEREE],
    );
    expect(role).toEqual([{ role: "owner" }]);
  });

  test("transfer invalidated by a membership deletion that commits while it waits", async () => {
    await addUser("u-xo", "xo@t.local");
    await addWorkspace("ws-xo", "u-xo");
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ('ws-xo', $1, 'member')`,
      [TRANSFEREE],
    );
    await holdAndRun(async (rsv) => {
      await rsv.unsafe(`begin`);
      // Hold the workspace row (members.ts lock protocol), then remove the
      // transfer target mid-flight.
      await rsv.unsafe(`select * from workspaces where id = 'ws-xo' for update`);
      let settled = false;
      const route = removeUser("u-xo", app, { transfer_to: TRANSFEREE }).then((r) => {
        settled = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // blocked behind the workspace lock
      await rsv.unsafe(
        `delete from workspace_members where workspace_id = 'ws-xo' and user_id = '${TRANSFEREE}'`,
      );
      await rsv.unsafe(`commit`);
      const res = (await route) as Response;
      expect(res.status).toBe(409); // revalidated under the lock: target gone
      const body = await errBody(res);
      expect(body.error.code).toBe("TRANSFER_TARGET_INVALID");
    });
    // No promotion, no ownerless workspace, user intact.
    expect(await q(`select 1 from users where id = 'u-xo'`)).toHaveLength(1);
    expect(
      await q(
        `select 1 from audit_log where workspace_id = 'ws-xo' and action = 'member.role_change'`,
      ),
    ).toHaveLength(0);
  });

  test("member add that waited behind an archived workspace inserts nothing", async () => {
    await addUser("u-aa", "aa@t.local");
    await addWorkspace("ws-aa", "u-aa");
    const membersApp = membersRoutes(db, fakeAuth("u-aa"));
    await holdAndRun(async (rsv) => {
      await rsv.unsafe(`begin`);
      await rsv.unsafe(`select * from workspaces where id = 'ws-aa' for update`);
      let settled = false;
      const route = membersApp
        .handle(
          new Request("http://t/api/v1/workspaces/ws-aa/members", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "member@t.local", role: "member" }),
          }),
        )
        .then(() => {
          settled = true;
          return undefined as unknown as Response;
        });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // blocked behind the workspace lock
      // Archive the workspace while the add is waiting.
      await rsv.unsafe(`update workspaces set status = 'suspended' where id = 'ws-aa'`);
      await rsv.unsafe(`delete from workspace_members where workspace_id = 'ws-aa'`);
      await rsv.unsafe(`commit`);
      await route;
      expect(settled).toBe(true);
    });
    // The stale-authorized insert must NOT have landed.
    expect(
      await q(`select 1 from workspace_members where workspace_id = 'ws-aa' and user_id = $1`, [
        MEMBER,
      ]),
    ).toHaveLength(0);
  });

  test("member role change serialized on workspace + membership rows", async () => {
    await addUser("u-rr", "rr@t.local");
    await addWorkspace("ws-rr", "u-rr");
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ('ws-rr', $1, 'member')`,
      [MEMBER],
    );
    const membersApp = membersRoutes(db, fakeAuth("u-rr"));
    await holdAndRun(async (rsv) => {
      await rsv.unsafe(`begin`);
      await rsv.unsafe(`select * from workspaces where id = 'ws-rr' for update`);
      let settled = false;
      let res: Response | undefined;
      const route = membersApp
        .handle(
          new Request("http://t/api/v1/workspaces/ws-rr/members/" + MEMBER, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role: "admin" }),
          }),
        )
        .then((r) => {
          settled = true;
          res = r;
        });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false);
      await rsv.unsafe(
        `delete from workspace_members where workspace_id = 'ws-rr' and user_id = '${MEMBER}'`,
      );
      await rsv.unsafe(`commit`);
      await route;
      expect(res!.status).toBe(403); // membership recheck under the lock
    });
    expect(
      await q(`select role from workspace_members where workspace_id = 'ws-rr' and user_id = $1`, [
        MEMBER,
      ]),
    ).toHaveLength(0);
  });

  test("concurrent cross-removal of two instance admins leaves one admin standing", async () => {
    await addUser("u-xa", "xa@t.local", true);
    await addUser("u-xb", "xb@t.local", true);
    await addWorkspace("ws-xa", "u-xa");
    await addWorkspace("ws-xb", "u-xb");
    const appA = adminExtraRoutes(db, fakeAuth("u-xa"), {});
    const appB = adminExtraRoutes(db, fakeAuth("u-xb"), {});
    const [ra, rb] = await Promise.all([
      removeUser("u-xb", appA, { confirm: true }),
      removeUser("u-xa", appB, { confirm: true }),
    ]);
    const statuses = [ra.status, rb.status].sort((a, b) => a - b);
    // Exactly one removal succeeds; the loser is blocked by the admin-set
    // lock + revalidation (403 deposed actor) or LAST_ADMIN count.
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect([403, 409]).toContain(statuses[1]!);
    // ADMIN is a third seeded admin: 3 - 1 removed = 2 remain. The invariant
    // under test: the loser never removes the winner's admin flag.
    const admins = await q<{ n: string }>(`select count(*) as n from instance_admins`);
    expect(Number(admins[0]!.n)).toBe(2);
  });

  test("key issuance that waited behind an archive inserts nothing", async () => {
    await addUser("u-kc", "kc@t.local");
    await addWorkspace("ws-kc", "u-kc");
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ('ws-kc', $1, 'admin')`,
      [MEMBER],
    );
    const keysApp = keysRoutes(db, fakeAuth(MEMBER));
    await holdAndRun(async (rsv) => {
      await rsv.unsafe(`begin`);
      await rsv.unsafe(`select * from workspaces where id = 'ws-kc' for update`);
      let settled = false;
      let res: Response | undefined;
      const route = keysApp
        .handle(
          new Request("http://t/api/v1/workspaces/ws-kc/keys", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "raced key" }),
          }),
        )
        .then((r) => {
          settled = true;
          res = r;
        });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false);
      await rsv.unsafe(`update workspaces set status = 'suspended' where id = 'ws-kc'`);
      await rsv.unsafe(`commit`);
      await route;
      expect(res!.status).toBe(403);
    });
    expect(await q(`select 1 from api_keys where workspace_id = 'ws-kc'`)).toHaveLength(0);
  });
});
