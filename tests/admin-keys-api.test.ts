// T9 — instance-admin generic key grant/list/revoke at
// /api/v1/admin/workspaces/:workspaceId/keys. Plaintext shown exactly once at
// grant, never on GET, never persisted in audit; revoke is terminal +
// idempotent with a single audit row; wrong-workspace key → 404; revoked key
// immediately fails gateway key auth; the workspace-scoped keys.ts routes keep
// rejecting instance admins who are not members (no widening).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import {
  users,
  workspaces,
  workspaceMembers,
  instanceAdmins,
  apiKeys,
  models,
  auditLog,
} from "../packages/db/src/schema";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";
import { adminKeysRoutes } from "../apps/api/src/routes/admin-keys";
import { keysRoutes } from "../apps/api/src/routes/keys";
import { v1ModelsRoutes } from "../apps/api/src/routes/v1-models";

const ADMIN_ID = "user-ak-admin";
const OWNER_ID = "user-ak-owner";
const MEMBER_ID = "user-ak-member";
const WS_A = "ws-ak-a";
const WS_B = "ws-ak-b";
const MODEL_A = "mdl-ak-a";
const MODEL_B = "mdl-ak-b";

let db: Db;
let drop: () => Promise<void>;

const authAs = (userId: string | null): BetterAuthInstance => ({
  handler: async () => new Response(null, { status: 404 }),
  api: {
    getSession: async () =>
      userId ? { user: { id: userId }, session: { id: `sess-${userId}`, userId } } : null,
  },
});

const appAs = (userId: string | null) =>
  adminKeysRoutes(db, authAs(userId))
    .use(keysRoutes(db, authAs(userId)))
    .use(v1ModelsRoutes(db));

type App = Awaited<ReturnType<typeof appAs>>;

function call(app: App, method: string, path: string, body?: unknown, bearer?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function audits(target: string, action?: string) {
  const all = await db
    .select({ target: auditLog.target, action: auditLog.action, detail: auditLog.detail })
    .from(auditLog);
  return all.filter((a) => a.target === target && (action === undefined || a.action === action));
}

const beforeAllPromise = (async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  const now = Date.now();
  await db.insert(users).values(
    [ADMIN_ID, OWNER_ID, MEMBER_ID].map((id, i) => ({
      id,
      name: `User ${i}`,
      email: `${id}@test`,
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })),
  );
  await db.insert(workspaces).values([
    { id: WS_A, name: "WS A", created_at: now },
    { id: WS_B, name: "WS B", created_at: now },
  ]);
  await db.insert(workspaceMembers).values([
    { workspace_id: WS_A, user_id: OWNER_ID, role: "owner" },
    { workspace_id: WS_A, user_id: MEMBER_ID, role: "member" },
  ]);
  await db.insert(instanceAdmins).values({ user_id: ADMIN_ID, created_at: now });
  await db.insert(models).values(
    [MODEL_A, MODEL_B].map((id) => ({
      id,
      public_id: `pub/${id}`,
      slug: id,
      display_name: id,
      provider: "openai",
      context_window: 128000,
      enabled: true,
      published: true,
      created_at: now,
      updated_at: now,
    })),
  );
})();

beforeAll(() => beforeAllPromise);
afterAll(() => drop());

describe("admin key routes auth", () => {
  test("anonymous → 401", async () => {
    const app = appAs(null);
    const res = await call(app, "GET", `/api/v1/admin/workspaces/${WS_A}/keys`);
    expect(res.status).toBe(401);
  });

  test("workspace owner and member (non-instance-admin) → 403", async () => {
    for (const u of [OWNER_ID, MEMBER_ID]) {
      const app = appAs(u);
      expect((await call(app, "GET", `/api/v1/admin/workspaces/${WS_A}/keys`)).status).toBe(403);
      expect(
        (await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys`, { name: "k" })).status,
      ).toBe(403);
      expect(
        (
          await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys/k1/revoke`, {
            reason: "r",
          })
        ).status,
      ).toBe(403);
    }
  });

  test("instance admin non-member → 200", async () => {
    const app = appAs(ADMIN_ID);
    const res = await call(app, "GET", `/api/v1/admin/workspaces/${WS_A}/keys`);
    expect(res.status).toBe(200);
  });

  test("unknown workspace → 404", async () => {
    const app = appAs(ADMIN_ID);
    expect((await call(app, "GET", "/api/v1/admin/workspaces/ws-nope/keys")).status).toBe(404);
    expect(
      (await call(app, "POST", "/api/v1/admin/workspaces/ws-nope/keys", { name: "k" })).status,
    ).toBe(404);
  });

  test("instance admin calling the workspace keys.ts route non-member → 403 unchanged", async () => {
    const app = appAs(ADMIN_ID);
    const res = await call(app, "POST", `/api/v1/workspaces/${WS_A}/keys`, { name: "k" });
    expect(res.status).toBe(403);
  });
});

describe("admin key grant", () => {
  test("unknown modelId → 400", async () => {
    const app = appAs(ADMIN_ID);
    const res = await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys`, {
      name: "k",
      modelIds: [MODEL_A, "mdl-ghost"],
    });
    expect(res.status).toBe(400);
  });

  test("grant returns plaintext once, persists hash+prefix, audits without secrets", async () => {
    const app = appAs(ADMIN_ID);
    const res = await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys`, {
      name: "grant-1",
      modelIds: [MODEL_B, MODEL_A],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      plaintext: string;
      key_prefix: string;
      modelIds: string[];
    };
    expect(body.plaintext.startsWith("sk-hbr-")).toBe(true);
    expect([...body.modelIds].sort()).toEqual([MODEL_A, MODEL_B].sort());

    const rows = (await db.$client.unsafe(
      `SELECT key_hash, key_prefix, purpose, status, workspace_id FROM api_keys WHERE id = $1`,
      [body.id] as never[],
    )) as {
      key_hash: string;
      key_prefix: string;
      purpose: string;
      status: string;
      workspace_id: string;
    }[];
    const row = rows[0]!;
    expect(row.key_hash).not.toContain(body.plaintext);
    expect(row.key_prefix).toBe(body.key_prefix);
    expect(row.purpose).toBe("generic");
    expect(row.status).toBe("enabled");
    expect(row.workspace_id).toBe(WS_A);

    const auditsFor = await audits(body.id);
    expect(auditsFor.map((a) => a.action)).toEqual(["admin.key.grant"]);
    expect(JSON.stringify(auditsFor[0]!.detail)).not.toContain(body.plaintext);
    expect(JSON.stringify(auditsFor[0]!.detail)).not.toContain(row.key_hash);
  });

  test("grant without modelIds = unrestricted (no permission rows)", async () => {
    const app = appAs(ADMIN_ID);
    const res = await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys`, {
      name: "grant-free",
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const perms = (await db.$client.unsafe(
      `SELECT model_id FROM api_key_model_permissions WHERE api_key_id = $1`,
      [id] as never[],
    )) as unknown[];
    expect(perms.length).toBe(0);
  });

  test("missing name → 400", async () => {
    const app = appAs(ADMIN_ID);
    const res = await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys`, {});
    expect(res.status).toBe(400);
  });
});

describe("admin key list", () => {
  test("generic only, no soft-deleted, no hash/plaintext, modelIds resolved", async () => {
    const app = appAs(ADMIN_ID);
    const create = await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys`, {
      name: "listed",
      modelIds: [MODEL_A],
    });
    const { id, plaintext } = (await create.json()) as { id: string; plaintext: string };
    const now = Date.now();
    await db.insert(apiKeys).values([
      {
        id: "key-ak-chat",
        workspace_id: WS_A,
        key_hash: "hash-chat",
        key_prefix: "sk-hbr-c...",
        name: "chat key",
        status: "enabled",
        purpose: "chat",
        created_at: now,
      },
      {
        id: "key-ak-dead",
        workspace_id: WS_A,
        key_hash: "hash-dead",
        key_prefix: "sk-hbr-d...",
        name: "removed key",
        status: "enabled",
        purpose: "generic",
        created_at: now,
        deleted_at: now,
      },
    ]);

    const res = await call(app, "GET", `/api/v1/admin/workspaces/${WS_A}/keys`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as {
      id: string;
      name: string;
      key_prefix: string;
      status: string;
      created_at: number;
      last_used_at: number | null;
      modelIds: string[];
    }[];
    const listed = list.find((k) => k.id === id);
    expect(listed).toBeTruthy();
    expect(listed!.modelIds).toEqual([MODEL_A]);
    // generic purpose only + soft-deleted excluded
    expect(list.some((k) => k.id === "key-ak-chat")).toBe(false);
    expect(list.some((k) => k.id === "key-ak-dead")).toBe(false);
    // no secret material anywhere in the response
    const raw = JSON.stringify(list);
    expect(raw).not.toContain(plaintext);
    expect(raw).not.toContain("key_hash");
    expect(raw).not.toContain("hash-chat");
  });
});

describe("admin key revoke", () => {
  test("missing reason → 400", async () => {
    const app = appAs(ADMIN_ID);
    const create = await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys`, { name: "r1" });
    const { id } = (await create.json()) as { id: string };
    const res = await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys/${id}/revoke`, {});
    expect(res.status).toBe(400);
  });

  test("revoke: terminal row + one audit with reason; replay idempotent without second audit", async () => {
    const app = appAs(ADMIN_ID);
    const create = await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys`, { name: "r2" });
    const { id, plaintext } = (await create.json()) as { id: string; plaintext: string };

    const res = await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys/${id}/revoke`, {
      reason: "admin cleanup",
    });
    expect(res.status).toBe(200);
    const first = (await res.json()) as { status: string };
    expect(first.status).toBe("revoked");

    const rows = (await db.$client.unsafe(`SELECT status, revoked_at FROM api_keys WHERE id = $1`, [
      id,
    ] as never[])) as { status: string; revoked_at: string | null }[];
    expect(rows[0]!.status).toBe("revoked");
    expect(rows[0]!.revoked_at).not.toBeNull();

    // revoked key rejected at the gateway key-auth path immediately
    const gw = await call(app, "GET", "/v1/models", undefined, plaintext);
    expect(gw.status).toBe(401);

    let auditRows = await audits(id, "admin.key.revoked");
    expect(auditRows.map((a) => a.action)).toEqual(["admin.key.revoked"]);
    expect(JSON.stringify(auditRows[0]!.detail)).toContain("admin cleanup");

    // replay: 200 {status:'revoked'}, no second audit row
    const replay = await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys/${id}/revoke`, {
      reason: "again",
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { status: string }).status).toBe("revoked");
    auditRows = await audits(id, "admin.key.revoked");
    expect(auditRows.length).toBe(1);
  });

  test("wrong-workspace keyId → 404", async () => {
    const app = appAs(ADMIN_ID);
    const create = await call(app, "POST", `/api/v1/admin/workspaces/${WS_B}/keys`, { name: "b" });
    const { id } = (await create.json()) as { id: string };
    const res = await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys/${id}/revoke`, {
      reason: "r",
    });
    expect(res.status).toBe(404);
  });

  test("concurrent revokes stay idempotent (exactly one audit row)", async () => {
    const app = appAs(ADMIN_ID);
    const create = await call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys`, { name: "c" });
    const { id } = (await create.json()) as { id: string };
    const results = await Promise.all([
      call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys/${id}/revoke`, { reason: "x" }),
      call(app, "POST", `/api/v1/admin/workspaces/${WS_A}/keys/${id}/revoke`, { reason: "x" }),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(((await r.json()) as { status: string }).status).toBe("revoked");
    }
    const auditRows = await audits(id, "admin.key.revoked");
    expect(auditRows.length).toBe(1);
  });
});
