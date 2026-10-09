// Integration: the admin-wallet-adjust and admin-keys route plugins as
// ACTUALLY MOUNTED by apps/api/src/app.ts buildApp (not standalone plugins).
// Proves: adjust auth (401/403), admin receipt + canonical private audit,
// idempotent replay (no double credit), reserved-aware debit, audit privacy
// (workspace members never see admin.wallet.adjust / admin.key.* rows —
// reason/idempotencyKey/actor unobtainable via action or before filters —
// while instance admins can), and admin key grant/list/revoke with workspace
// isolation, generic purpose, plaintext-shown-once, no hash material on any
// list response, and revoked keys rejected at the gateway key-auth path.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { buildApp } from "../apps/api/src/app";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";

const NOW = 1_700_000_000_000;
const ADMIN = "user-mount-admin";
const MEMBER = "user-mount-member";
const WS_A = "ws-mount-a";
const WS_B = "ws-mount-b";
const ADJUST_KEY = "idem-key-0123456789abcdef";

let db: Db;
let drop: () => Promise<void>;
let anonApp: Awaited<ReturnType<typeof buildApp>>;
let memberApp: Awaited<ReturnType<typeof buildApp>>;
let adminApp: Awaited<ReturnType<typeof buildApp>>;

const fakeAuth = (userId: string | null): BetterAuthInstance => ({
  handler: async () => new Response(null, { status: 404 }),
  api: {
    getSession: async () =>
      userId ? { user: { id: userId }, session: { id: `sess-${userId}`, userId } } : null,
  },
});

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.$client.unsafe(text, params as never[])) as T[];
}

async function api(
  app: Awaited<ReturnType<typeof buildApp>>,
  path: string,
  init?: { method?: string; body?: unknown; bearer?: string },
): Promise<{ status: number; body: Record<string, unknown> | unknown[] }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init?.bearer) headers["authorization"] = `Bearer ${init.bearer}`;
  const res = await app.handle(
    new Request(`http://test${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> | unknown[];
  return { status: res.status, body };
}

const adjust = (wsId: string, body: unknown, app = adminApp) =>
  api(app, `/api/v1/admin/workspaces/${wsId}/wallet/adjust`, { method: "POST", body });

const ADJUST_BODY = { delta: 250_000, reason: "manual correction", idempotencyKey: ADJUST_KEY };

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
    `insert into workspaces (id, name, status, created_at) values
     ($1, 'WS A', 'active', $3), ($2, 'WS B', 'active', $3)`,
    [WS_A, WS_B, NOW],
  );
  // wal-a: fresh topup wallet; wal-b: pre-funded with a reservation so the
  // reserved-debit guard is exercised against real money state.
  await q(
    `insert into wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
     values ('wal-mount-a', $1, 'VND', 'topup', 0, 0, 0, $3),
            ('wal-mount-b', $2, 'VND', 'topup', 250000, 100000, 0, $3)`,
    [WS_A, WS_B, NOW],
  );
  await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [
    WS_A,
    MEMBER,
  ]);
  anonApp = await buildApp({ db, auth: fakeAuth(null) });
  memberApp = await buildApp({ db, auth: fakeAuth(MEMBER) });
  adminApp = await buildApp({ db, auth: fakeAuth(ADMIN) });
});

afterAll(async () => {
  await drop();
});

describe("mounted POST /api/v1/admin/workspaces/:id/wallet/adjust", () => {
  test("anonymous → 401", async () => {
    const res = await adjust(WS_A, ADJUST_BODY, anonApp);
    expect(res.status).toBe(401);
  });

  test("workspace member (non-instance-admin) → 403, nothing written", async () => {
    const res = await adjust(WS_A, ADJUST_BODY, memberApp);
    expect(res.status).toBe(403);
    const rows = await q<{ n: number }>(`select count(*)::int as n from admin_wallet_adjustments`);
    expect(rows[0]!.n).toBe(0);
    const wallets = await q<{ balance: number }>(
      `select balance::int from wallets where id = 'wal-mount-a'`,
    );
    expect(wallets[0]!.balance).toBe(0);
  });

  test("admin adjust returns the receipt, credits the wallet, writes the private audit", async () => {
    const res = await adjust(WS_A, ADJUST_BODY);
    expect(res.status).toBe(200);
    const receipt = res.body as Record<string, unknown>;
    expect(receipt.workspaceId).toBe(WS_A);
    expect(receipt.balanceBefore).toBe(0);
    expect(receipt.balanceAfter).toBe(250_000);
    expect(receipt.replayed).toBe(false);
    expect(typeof receipt.ledgerEntryId).toBe("string");
    const wallets = await q<{ balance: number }>(
      `select balance::int from wallets where id = 'wal-mount-a'`,
    );
    expect(wallets[0]!.balance).toBe(250_000);
    const audit = await q<{ action: string; actor_user_id: string; detail: unknown }>(
      `select action, actor_user_id, detail from audit_log where target = 'wal-mount-a'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("admin.wallet.adjust");
    expect(audit[0]!.actor_user_id).toBe(ADMIN);
    // raw SQL returns the jsonb column as a string
    const detail =
      typeof audit[0]!.detail === "string"
        ? (JSON.parse(audit[0]!.detail as string) as Record<string, unknown>)
        : (audit[0]!.detail as Record<string, unknown>);
    expect(detail.idempotencyKey).toBe(ADJUST_KEY);
    expect(detail.reason).toBe("manual correction");
  });

  test("replay same actor+key returns the original receipt: no double credit, one receipt row", async () => {
    const second = await adjust(WS_A, ADJUST_BODY);
    expect(second.status).toBe(200);
    const receipt = second.body as Record<string, unknown>;
    expect(receipt.replayed).toBe(true);
    expect(receipt.balanceAfter).toBe(250_000);
    const wallets = await q<{ balance: number }>(
      `select balance::int from wallets where id = 'wal-mount-a'`,
    );
    expect(wallets[0]!.balance).toBe(250_000);
    const rows = await q<{ n: number }>(
      `select count(*)::int as n from admin_wallet_adjustments where workspace_id = $1`,
      [WS_A],
    );
    expect(rows[0]!.n).toBe(1);
    const audit = await q<{ n: number }>(
      `select count(*)::int as n from audit_log where target = 'wal-mount-a'`,
    );
    expect(audit[0]!.n).toBe(1);
  });

  test("debit cannot cross the wallet reservation", async () => {
    const tooFar = await adjust(WS_B, {
      delta: -200_000,
      reason: "overshoot",
      idempotencyKey: "idem-key-reserved-000001",
    });
    expect(tooFar.status).toBe(409);
    const unchanged = await q<{ balance: number; reserved: number }>(
      `select balance::int, reserved::int from wallets where id = 'wal-mount-b'`,
    );
    expect(unchanged[0]!.balance).toBe(250_000);
    expect(unchanged[0]!.reserved).toBe(100_000);
    const ok = await adjust(WS_B, {
      delta: -100_000,
      reason: "within available",
      idempotencyKey: "idem-key-reserved-000002",
    });
    expect(ok.status).toBe(200);
    const after = ok.body as Record<string, unknown> as Record<string, unknown>;
    expect(after.balanceAfter).toBe(150_000);
    expect(after.reserved).toBe(100_000);
  });
});

describe("mounted GET /api/v1/audit privacy", () => {
  test("workspace member never sees admin.* rows: plain, action-filtered, or before-cursored", async () => {
    // A non-admin audit event in the same workspace, so the exclusion is
    // proven against a populated list (not an empty workspace).
    const memberKey = await api(memberApp, `/api/v1/workspaces/${WS_A}/keys`, {
      method: "POST",
      body: { name: "member key" },
    });
    expect(memberKey.status).toBe(201);
    const plain = (await api(memberApp, `/api/v1/audit?workspace_id=${WS_A}`)).body as Array<
      Record<string, unknown>
    >;
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.some((r) => r.action === "key.create")).toBe(true);
    for (const row of plain) expect(String(row.action).startsWith("admin.")).toBe(false);
    for (const row of plain) {
      const detail = row.detail as Record<string, unknown> | null;
      if (detail && typeof detail === "object") {
        expect(detail).not.toHaveProperty("idempotencyKey");
        expect(detail).not.toHaveProperty("reason");
      }
    }
    const filtered = (
      await api(memberApp, `/api/v1/audit?workspace_id=${WS_A}&action=admin.wallet`)
    ).body as unknown[];
    expect(filtered).toEqual([]);
    const cursored = (
      await api(memberApp, `/api/v1/audit?workspace_id=${WS_A}&before=${NOW + 10_000}&limit=200`)
    ).body as Array<Record<string, unknown>>;
    for (const row of cursored) expect(String(row.action).startsWith("admin.")).toBe(false);
  });

  test("instance admin reads the same workspace audit including the private admin row", async () => {
    const rows = (await api(adminApp, `/api/v1/audit?workspace_id=${WS_A}`)).body as Array<
      Record<string, unknown>
    >;
    const adjustRows = rows.filter((r) => r.action === "admin.wallet.adjust");
    expect(adjustRows).toHaveLength(1);
    const detail = adjustRows[0]!.detail as Record<string, unknown>;
    expect(detail.idempotencyKey).toBe(ADJUST_KEY);
    expect(detail.reason).toBe("manual correction");
    expect(adjustRows[0]!.actor_user_id).toBe(ADMIN);
  });
});

describe("mounted admin keys at /api/v1/admin/workspaces/:id/keys", () => {
  test("anonymous → 401, workspace member → 403", async () => {
    expect((await api(anonApp, `/api/v1/admin/workspaces/${WS_A}/keys`)).status).toBe(401);
    expect((await api(memberApp, `/api/v1/admin/workspaces/${WS_A}/keys`)).status).toBe(403);
  });

  test("grant: plaintext exactly once, generic purpose, no hash anywhere in the response", async () => {
    const res = await api(adminApp, `/api/v1/admin/workspaces/${WS_A}/keys`, {
      method: "POST",
      body: { name: "ci key" },
    });
    expect(res.status).toBe(201);
    const granted = res.body as Record<string, unknown>;
    expect(typeof granted.plaintext).toBe("string");
    expect(String(granted.plaintext).startsWith("sk-hbr-")).toBe(true);
    expect(granted.purpose).toBe("generic");
    expect(JSON.stringify(granted)).not.toContain("key_hash");
    expect(JSON.stringify(granted)).not.toContain("hash");
    const dbRow = await q<{ purpose: string; key_hash: string }>(
      `select purpose, key_hash from api_keys where id = $1`,
      [granted.id as string],
    );
    expect(dbRow[0]!.purpose).toBe("generic");
    expect(dbRow[0]!.key_hash).not.toBeNull();

    // list: no plaintext, no hash material
    const list = (await api(adminApp, `/api/v1/admin/workspaces/${WS_A}/keys`)).body as Array<
      Record<string, unknown>
    >;
    const listed = list.find((k) => k.id === granted.id);
    expect(listed).toBeDefined();
    expect(listed!.status).toBe("enabled");
    expect(JSON.stringify(list)).not.toContain(granted.plaintext as string);
    expect(JSON.stringify(list)).not.toContain("key_hash");

    // workspace isolation: the key belongs to WS_A only
    const wsB = (await api(adminApp, `/api/v1/admin/workspaces/${WS_B}/keys`)).body as unknown[];
    expect(wsB).toEqual([]);
    const wrongWs = await api(
      adminApp,
      `/api/v1/admin/workspaces/${WS_B}/keys/${granted.id}/revoke`,
      {
        method: "POST",
        body: { reason: "wrong workspace" },
      },
    );
    expect(wrongWs.status).toBe(404);

    // revoke: terminal, single audit row, idempotent replay
    const revoke = await api(
      adminApp,
      `/api/v1/admin/workspaces/${WS_A}/keys/${granted.id}/revoke`,
      {
        method: "POST",
        body: { reason: "rotate" },
      },
    );
    expect(revoke.status).toBe(200);
    expect((revoke.body as Record<string, unknown>).status).toBe("revoked");
    const replay = await api(
      adminApp,
      `/api/v1/admin/workspaces/${WS_A}/keys/${granted.id}/revoke`,
      {
        method: "POST",
        body: { reason: "rotate again" },
      },
    );
    expect(replay.status).toBe(200);
    const revokes = await q<{ n: number }>(
      `select count(*)::int as n from audit_log where target = $1 and action = 'admin.key.revoked'`,
      [granted.id as string],
    );
    expect(revokes[0]!.n).toBe(1);

    // revoked key rejected at the gateway key-auth path immediately
    const gateway = await api(adminApp, `/v1/models`, { bearer: granted.plaintext as string });
    expect(gateway.status).toBe(401);
  });
});
