// T8-audit — workspace-scoped /api/v1/audit privacy: for a requester who is a
// workspace admin/owner but NOT an instance admin, rows with action
// 'admin.wallet.adjust' or 'admin.key.*' must be excluded by the SQL predicate
// BEFORE cursor/limit and enrichment — unobtainable through any query variant
// (bare, action= prefix, action= exact, before+limit). The same query as an
// instance admin returns the full record with reason, delta, and actor email.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import {
  users,
  workspaces,
  workspaceMembers,
  instanceAdmins,
  auditLog,
  wallets,
} from "../packages/db/src/schema";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";
import { auditRoutes } from "../apps/api/src/routes/audit";

const ADMIN_ID = "user-ap-admin";
const OWNER_ID = "user-ap-owner";
const WS_ID = "ws-ap";
const WALLET_ID = "wal-ap";
const KEY_ID = "key-ap-1";
const REASON = "private-adjust-reason-x";
const REASON_2 = "private-adjust-reason-two";
const IDEMPOTENCY_KEY = "idem-key-priv-0001";
const REVOKE_REASON = "private-revoke-reason-x";

let db: Db;
let drop: () => Promise<void>;

const authAs = (userId: string): BetterAuthInstance => ({
  handler: async () => new Response(null, { status: 404 }),
  api: {
    getSession: async () => ({ user: { id: userId }, session: { id: `sess-${userId}`, userId } }),
  },
});

const appAs = (userId: string) => auditRoutes(db, authAs(userId));

function call(app: Awaited<ReturnType<typeof appAs>>, query: string) {
  return app.handle(new Request(`http://localhost/api/v1/audit?${query}`));
}

interface Row {
  id?: string;
  action: string;
  detail: unknown;
  actor: { email: string } | null;
}

const PRIVILEGED = (a: string) => a === "admin.wallet.adjust" || a.startsWith("admin.key.");

let seededAt = 0;
void seededAt;

const beforeAllPromise = (async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  const now = Date.now();
  seededAt = now;
  await db.insert(users).values(
    [ADMIN_ID, OWNER_ID].map((id) => ({
      id,
      name: id,
      email: `${id}@test`,
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })),
  );
  await db.insert(workspaces).values({ id: WS_ID, name: "WS", created_at: now });
  await db
    .insert(workspaceMembers)
    .values({ workspace_id: WS_ID, user_id: OWNER_ID, role: "owner" });
  await db.insert(instanceAdmins).values({ user_id: ADMIN_ID, created_at: now });
  await db.insert(wallets).values({
    id: WALLET_ID,
    workspace_id: WS_ID,
    currency: "VND",
    balance: 100000,
    reserved: 0,
    version: 0,
    created_at: now,
  });
  await db.insert(auditLog).values([
    {
      id: "aud-ap-adjust",
      actor_user_id: ADMIN_ID,
      workspace_id: WS_ID,
      action: "admin.wallet.adjust",
      target: WALLET_ID,
      detail: { delta: 50000, reason: REASON },
      created_at: now,
    },
    {
      // Post-adjust canonical event carrying the full privileged detail shape
      // (reason + idempotencyKey) the wallet lane writes on settlement.
      id: "aud-ap-adjust-2",
      actor_user_id: ADMIN_ID,
      workspace_id: WS_ID,
      action: "admin.wallet.adjust",
      target: WALLET_ID,
      detail: { delta: -25000, reason: REASON_2, idempotencyKey: IDEMPOTENCY_KEY },
      created_at: now + 7,
    },
    {
      id: "aud-ap-grant",
      actor_user_id: ADMIN_ID,
      workspace_id: WS_ID,
      action: "admin.key.grant",
      target: KEY_ID,
      detail: { keyId: KEY_ID, modelIds: [] },
      created_at: now + 5,
    },
    {
      id: "aud-ap-revoke",
      actor_user_id: ADMIN_ID,
      workspace_id: WS_ID,
      action: "admin.key.revoked",
      target: KEY_ID,
      detail: { keyId: KEY_ID, reason: REVOKE_REASON },
      created_at: now + 6,
    },
    {
      id: "aud-ap-plain",
      actor_user_id: OWNER_ID,
      workspace_id: WS_ID,
      action: "key.create",
      target: KEY_ID,
      detail: { name: "plain key" },
      created_at: now + 3,
    },
  ]);
})();

beforeAll(() => beforeAllPromise);
afterAll(() => drop());

describe("audit privacy for non-instance-admin workspace admin", () => {
  // Evaluated lazily: seededAt is set during beforeAll, not at module load.
  const variants = () => [
    `workspace_id=${WS_ID}`,
    `workspace_id=${WS_ID}&action=admin.`,
    `workspace_id=${WS_ID}&action=admin.wallet.adjust`,
    `workspace_id=${WS_ID}&action=admin.key.`,
    `workspace_id=${WS_ID}&before=${Date.now() + 3_600_000}&limit=200`,
    `workspace_id=${WS_ID}&limit=1`,
  ];

  for (const v of variants()) {
    test(`variant "${v}" contains zero privileged rows and no private detail`, async () => {
      const res = await call(appAs(OWNER_ID), v);
      expect(res.status).toBe(200);
      const text = JSON.stringify(await res.json());
      expect(text).not.toContain("admin.wallet.adjust");
      expect(text).not.toContain("admin.key");
      expect(text).not.toContain(REASON);
      expect(text).not.toContain(REVOKE_REASON);
      expect(text).not.toContain(`${ADMIN_ID}@test`);
    });
  }

  for (const v of variants()) {
    test(`post-adjust canonical row (reason + idempotencyKey) never leaks via "${v}"`, async () => {
      const res = await call(appAs(OWNER_ID), v);
      expect(res.status).toBe(200);
      const text = JSON.stringify(await res.json());
      expect(text).not.toContain(REASON_2);
      expect(text).not.toContain(IDEMPOTENCY_KEY);
      expect(text).not.toContain("aud-ap-adjust-2");
    });
  }

  test("instance admin still reads the post-adjust canonical row in full", async () => {
    // False-pass guard: the row exists and is visible to the instance admin,
    // so the exclusions above come from the privacy predicate, not the seed.
    const res = await call(appAs(ADMIN_ID), `workspace_id=${WS_ID}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Row[];
    const adjust2 = rows.find((r) => r.id === "aud-ap-adjust-2");
    expect(adjust2).toBeTruthy();
    const text = JSON.stringify(adjust2);
    expect(text).toContain(REASON_2);
    expect(text).toContain(IDEMPOTENCY_KEY);
    expect(adjust2!.actor?.email).toBe(`${ADMIN_ID}@test`);
  });

  test("bare variant still returns the workspace's own non-privileged rows", async () => {
    const res = await call(appAs(OWNER_ID), `workspace_id=${WS_ID}`);
    const rows = (await res.json()) as Row[];
    expect(rows.some((r) => r.action === "key.create")).toBe(true);
  });

  test("limit=1 after exclusion returns the newest VISIBLE row, not a leaked privileged row", async () => {
    // admin.key.revoked (now+6) is the newest row overall; with the predicate
    // applied BEFORE limit, the newest VISIBLE row is key.create (now+3).
    const res = await call(appAs(OWNER_ID), `workspace_id=${WS_ID}&limit=1`);
    const rows = (await res.json()) as Row[];
    expect(rows.length).toBe(1);
    expect(PRIVILEGED(rows[0]!.action)).toBe(false);
  });
});

describe("audit privacy for instance admin", () => {
  test("same workspace query returns the full privileged record", async () => {
    const res = await call(appAs(ADMIN_ID), `workspace_id=${WS_ID}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Row[];
    const adjust = rows.find((r) => r.id === "aud-ap-adjust");
    expect(adjust).toBeTruthy();
    expect(JSON.stringify(adjust!.detail)).toContain(REASON);
    expect(JSON.stringify(adjust!.detail)).toContain("50000");
    expect(adjust!.actor?.email).toBe(`${ADMIN_ID}@test`);
    expect(rows.some((r) => r.action === "admin.key.revoked")).toBe(true);
  });

  test("global scope (no workspace_id) still works for instance admin", async () => {
    const res = await call(appAs(ADMIN_ID), "");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Row[];
    expect(rows.some((r) => r.action === "admin.wallet.adjust")).toBe(true);
  });
});
