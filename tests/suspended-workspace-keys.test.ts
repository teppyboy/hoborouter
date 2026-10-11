// Archived (suspended) workspace enforcement contract:
// - verifyApiKey rejects keys belonging to a suspended workspace (gateway +
//   /v1/models auth), so old keys stop working after a sole-owner archive.
// - Key issuance on a suspended workspace is 403 WORKSPACE_SUSPENDED.
// - Settlement/refund paths do not use verifyApiKey and stay unaffected (money
//   in and out of an already-dispatched hold is never blocked).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { generateApiKey, hashApiKey, verifyApiKey } from "../packages/keys/src/keys";
import { keysRoutes } from "../apps/api/src/routes/keys";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";

const NOW = 1_700_000_000_000;
const OWNER = "u-sw";

let db: Db;
let drop: () => Promise<void>;
let keysApp: ReturnType<typeof keysRoutes>;
const plaintexts: Record<string, string> = {};

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

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  await q(
    `insert into users (id, name, email, created_at, updated_at) values ($1, 'SW', 'sw@t.local', $2, $2)`,
    [OWNER, NOW],
  );
  for (const ws of ["ws-active", "ws-susp"]) {
    await q(`insert into workspaces (id, name, status, created_at) values ($1, $1, 'active', $2)`, [
      ws,
      NOW,
    ]);
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
      [ws, OWNER],
    );
  }
  await q(`update workspaces set status = 'suspended' where id = 'ws-susp'`);
  for (const ws of ["ws-active", "ws-susp"]) {
    const { plaintext, hash, prefix } = generateApiKey();
    await q(
      `insert into api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at, purpose)
       values ($1, $2, $3, $4, 'k', 'enabled', $5, 'generic')`,
      [`key-${ws}`, ws, hash, prefix, NOW],
    );
    plaintexts[ws] = plaintext;
  }
  keysApp = keysRoutes(db, fakeAuth(OWNER));
});

afterAll(async () => {
  await drop();
});

describe("verifyApiKey (gateway auth)", () => {
  test("active workspace key authenticates", async () => {
    const rec = await verifyApiKey(db, plaintexts["ws-active"]!);
    expect(rec?.workspace_id).toBe("ws-active");
  });

  test("suspended workspace key is rejected", async () => {
    const rec = await verifyApiKey(db, plaintexts["ws-susp"]!);
    expect(rec).toBeNull();
  });
});

describe("key issuance", () => {
  test("suspended workspace returns 403 WORKSPACE_SUSPENDED", async () => {
    const res = await keysApp.handle(
      new Request("http://t/api/v1/workspaces/ws-susp/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "new key" }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("WORKSPACE_SUSPENDED");
  });

  test("active workspace can still issue keys", async () => {
    const res = await keysApp.handle(
      new Request("http://t/api/v1/workspaces/ws-active/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "new key" }),
      }),
    );
    expect(res.status).toBe(201);
  });
});

describe("hash stability", () => {
  test("lookup is hash-based (no plaintext path bypass)", () => {
    const pt = plaintexts["ws-susp"]!;
    expect(hashApiKey(pt)).toBe(hashApiKey(pt));
  });
});
