// API key lifecycle: rename (PATCH name) and REMOVE as soft delete — a removed
// key disappears from the management list and never authenticates again, but
// the row (and its name/prefix for audit + usage joins) is retained per the
// repo soft-delete convention (deleted_at/deleted_by). Existing revoke (DELETE)
// behavior must stay intact: revoked keys remain visible with status 'revoked'.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { users, workspaces, workspaceMembers, apiKeys } from "../packages/db/src/schema";
import { generateApiKey, verifyApiKey } from "../packages/keys/src/keys";
import { buildApp } from "../apps/api/src/app";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";

const USER_ID = "user-keys-1";
const MEMBER_ID = "user-keys-member";
const WS_ID = "ws-keys";

let db: Db;
let drop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;

const fakeAuth = (userId: string): BetterAuthInstance => ({
  handler: async () => new Response(null, { status: 404 }),
  api: {
    getSession: async () => ({
      user: { id: userId },
      session: { id: `sess-${userId}`, userId },
    }),
  },
});

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  const now = Date.now();
  await db.insert(users).values([
    {
      id: USER_ID,
      name: "Owner",
      email: "owner@test",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
    {
      id: MEMBER_ID,
      name: "Member",
      email: "member@test",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
  ]);
  await db.insert(workspaces).values({ id: WS_ID, name: "WS", created_at: now });
  await db.insert(workspaceMembers).values([
    { workspace_id: WS_ID, user_id: USER_ID, role: "owner" },
    { workspace_id: WS_ID, user_id: MEMBER_ID, role: "member" },
  ]);
  app = await buildApp({ db, auth: fakeAuth(USER_ID) });
});

afterAll(async () => {
  await drop();
});

let seq = 0;
async function seedKey(status: "enabled" | "disabled" | "revoked" = "enabled") {
  const { plaintext, hash, prefix } = generateApiKey();
  const id = `key-${++seq}`;
  await db.insert(apiKeys).values({
    id,
    workspace_id: WS_ID,
    key_hash: hash,
    key_prefix: prefix,
    name: `Key ${seq}`,
    status,
    created_at: Date.now(),
  });
  return { id, plaintext };
}

function call(method: string, path: string, body?: unknown) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function audits(target: string): Promise<{ action: string; detail: unknown }[]> {
  return (await db.$client.unsafe(
    `SELECT action, detail FROM audit_log WHERE target = $1 ORDER BY action`,
    [target] as never[],
  )) as { action: string; detail: unknown }[];
}

async function keyRow(id: string) {
  const rows = (await db.$client.unsafe(
    `SELECT name, status, revoked_at, deleted_at, deleted_by FROM api_keys WHERE id = $1`,
    [id] as never[],
  )) as {
    name: string;
    status: string;
    revoked_at: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
  }[];
  const r = rows[0];
  if (!r) return null;
  // bigint columns arrive as strings from the raw driver
  return {
    ...r,
    revoked_at: r.revoked_at === null ? null : Number(r.revoked_at),
    deleted_at: r.deleted_at === null ? null : Number(r.deleted_at),
  };
}

async function listedIds(): Promise<string[]> {
  const res = await call("GET", `/api/v1/workspaces/${WS_ID}/keys`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }[]).map((k) => k.id);
}

describe("rename (PATCH name)", () => {
  test("renames, keeps status, writes key.rename audit with previous name", async () => {
    const { id } = await seedKey();
    const res = await call("PATCH", `/api/v1/workspaces/${WS_ID}/keys/${id}`, {
      name: " Renamed ",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, name: "Renamed", status: "enabled" });
    const row = await keyRow(id);
    expect(row?.name).toBe("Renamed");
    const audits1 = await audits(id);
    expect(audits1.map((a) => a.action)).toContain("key.rename");
    const rename = audits1.find((a) => a.action === "key.rename");
    const detail = typeof rename?.detail === "string" ? JSON.parse(rename.detail) : rename?.detail;
    expect(detail).toEqual({ name: "Renamed", previous_name: "Key 1" });
  });

  test("rejects empty or oversized names", async () => {
    const { id } = await seedKey();
    expect(
      (await call("PATCH", `/api/v1/workspaces/${WS_ID}/keys/${id}`, { name: "   " })).status,
    ).toBe(400);
    expect(
      (await call("PATCH", `/api/v1/workspaces/${WS_ID}/keys/${id}`, { name: "x".repeat(129) }))
        .status,
    ).toBe(400);
  });
});

describe("remove (soft delete)", () => {
  test("removed key: hidden from list, row retained, never authenticates, audited", async () => {
    const { id, plaintext } = await seedKey();
    // sanity: authenticates before removal
    expect(await verifyApiKey(db, plaintext)).not.toBeNull();

    const res = await call("POST", `/api/v1/workspaces/${WS_ID}/keys/${id}/remove`);
    expect(res.status).toBe(200);

    expect(await listedIds()).not.toContain(id);
    const row = await keyRow(id);
    // soft delete: row kept, status untouched, deleted_at/deleted_by stamped
    expect(row).not.toBeNull();
    expect(row?.status).toBe("enabled");
    expect(row?.deleted_at).toBeGreaterThan(0);
    expect(row?.deleted_by).toBe(USER_ID);

    // removed keys never authenticate even with status still 'enabled'
    expect(await verifyApiKey(db, plaintext)).toBeNull();

    const actions = (await audits(id)).map((a) => a.action);
    expect(actions).toContain("key.remove");
  });

  test("removed key is inert for all management routes (404), re-remove 404", async () => {
    const { id } = await seedKey();
    expect((await call("POST", `/api/v1/workspaces/${WS_ID}/keys/${id}/remove`)).status).toBe(200);

    expect(
      (await call("PATCH", `/api/v1/workspaces/${WS_ID}/keys/${id}`, { name: "zombie" })).status,
    ).toBe(404);
    expect(
      (await call("PATCH", `/api/v1/workspaces/${WS_ID}/keys/${id}`, { status: "disabled" }))
        .status,
    ).toBe(404);
    expect((await call("DELETE", `/api/v1/workspaces/${WS_ID}/keys/${id}`)).status).toBe(404);
    expect((await call("GET", `/api/v1/workspaces/${WS_ID}/keys/${id}/models`)).status).toBe(404);
    // idempotent-ish: removing again acts on an already-hidden key → 404
    expect((await call("POST", `/api/v1/workspaces/${WS_ID}/keys/${id}/remove`)).status).toBe(404);
  });

  test("member role is forbidden from removing", async () => {
    const { id } = await seedKey();
    const memberApp = await buildApp({ db, auth: fakeAuth(MEMBER_ID) });
    const res = await memberApp.handle(
      new Request(`http://localhost/api/v1/workspaces/${WS_ID}/keys/${id}/remove`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(403);
    expect(await keyRow(id)).not.toBeNull();
  });
});

describe("revoke compatibility (existing DELETE)", () => {
  test("DELETE still revokes: status revoked, revoked_at set, key stays listed", async () => {
    const { id, plaintext } = await seedKey();
    const res = await call("DELETE", `/api/v1/workspaces/${WS_ID}/keys/${id}`);
    expect(res.status).toBe(200);

    const row = await keyRow(id);
    expect(row?.status).toBe("revoked");
    expect(row?.revoked_at).toBeGreaterThan(0);
    expect(row?.deleted_at).toBeNull();

    // revoked keys remain visible in the management list
    expect(await listedIds()).toContain(id);
    expect(await verifyApiKey(db, plaintext)).toBeNull();
    expect((await audits(id)).map((a) => a.action)).toContain("key.revoke");
  });

  test("DELETE on already-revoked key is idempotent: 200, no second audit, revoked_at unchanged", async () => {
    const { id } = await seedKey();
    expect((await call("DELETE", `/api/v1/workspaces/${WS_ID}/keys/${id}`)).status).toBe(200);
    const first = await keyRow(id);
    const firstAudits = (await audits(id)).filter((a) => a.action === "key.revoke");
    expect(firstAudits).toHaveLength(1);

    // replay: terminal no-op — no revoked_at churn, no extra audit, row kept
    expect((await call("DELETE", `/api/v1/workspaces/${WS_ID}/keys/${id}`)).status).toBe(200);
    const second = await keyRow(id);
    expect(second?.status).toBe("revoked");
    expect(second?.revoked_at).toBe(first?.revoked_at);
    expect(second?.deleted_at).toBeNull();
    expect((await audits(id)).filter((a) => a.action === "key.revoke")).toHaveLength(1);
    expect(await listedIds()).toContain(id);
  });

  test("cross-workspace key id still 404s on DELETE", async () => {
    // user is a member of a second workspace but the key belongs to WS_ID
    await db.insert(workspaces).values({ id: "ws-other", name: "Other", created_at: Date.now() });
    await db
      .insert(workspaceMembers)
      .values({ workspace_id: "ws-other", user_id: USER_ID, role: "owner" });
    const { id } = await seedKey();
    expect((await call("DELETE", `/api/v1/workspaces/ws-other/keys/${id}`)).status).toBe(404);
    expect((await keyRow(id))?.status).toBe("enabled");
  });

  test("revoked key can still be removed from the list afterwards", async () => {
    const { id } = await seedKey("revoked");
    expect((await call("POST", `/api/v1/workspaces/${WS_ID}/keys/${id}/remove`)).status).toBe(200);
    expect(await listedIds()).not.toContain(id);
  });
});
