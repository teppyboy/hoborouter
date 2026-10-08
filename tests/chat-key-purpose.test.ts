// Chat-key provenance (spec 2026-10-08 rev5 §1a): api_keys.purpose is
// server-owned state. A dedicated owner/admin route mints purpose 'chat'
// keys; the ordinary /keys route always creates 'generic' (clients cannot
// set purpose); verifyApiKey returns purpose so the gateway can resolve the
// 1 MiB vs 16 MiB cap. Plaintext shown exactly once; mint is audited.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { users, workspaces, workspaceMembers, apiKeys } from "../packages/db/src/schema";
import { generateApiKey, hashApiKey, verifyApiKey } from "../packages/keys/src/keys";
import { buildApp } from "../apps/api/src/app";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";

const OWNER_ID = "user-ck-owner";
const ADMIN_ID = "user-ck-admin";
const MEMBER_ID = "user-ck-member";
const WS_ID = "ws-ck";

let db: Db;
let drop: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  const now = new Date(Date.now());
  await db.insert(users).values(
    [OWNER_ID, ADMIN_ID, MEMBER_ID].map((id, i) => ({
      id,
      name: `U${i}`,
      email: `${id}@test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await db.insert(workspaces).values({ id: WS_ID, name: "WS", created_at: Date.now() });
  await db.insert(workspaceMembers).values([
    { workspace_id: WS_ID, user_id: OWNER_ID, role: "owner" },
    { workspace_id: WS_ID, user_id: ADMIN_ID, role: "admin" },
    { workspace_id: WS_ID, user_id: MEMBER_ID, role: "member" },
  ]);
});

afterAll(async () => {
  await drop();
});

// The fixture auth resolves the session from a request header (test-only
// selector), so one app instance can exercise owner/admin/member authorization.
const headerAuth: BetterAuthInstance = {
  handler: async () => new Response(null, { status: 404 }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const userId = headers.get("x-hbr-test-user");
      if (!userId) return null;
      return { user: { id: userId }, session: { id: `sess-${userId}`, userId } };
    },
  },
};

let app2: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app2 = await buildApp({ db, auth: headerAuth });
});

function hcall(method: string, path: string, body?: unknown, user = OWNER_ID): Promise<Response> {
  const headers: Record<string, string> = { "x-hbr-test-user": user };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app2.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function dbRow(id: string): Promise<{ purpose: string; name: string } | null> {
  const rows = (await db.$client.unsafe(`SELECT purpose, name FROM api_keys WHERE id = $1`, [
    id,
  ] as never[])) as { purpose: string; name: string }[];
  return rows[0] ?? null;
}

async function audits(target: string): Promise<{ action: string; detail: unknown }[]> {
  return (await db.$client.unsafe(
    `SELECT action, detail FROM audit_log WHERE target = $1 ORDER BY action`,
    [target] as never[],
  )) as { action: string; detail: unknown }[];
}

describe("POST /chat-key", () => {
  test("owner mints a chat-purpose key: purpose in response, row, and verifyApiKey; plaintext works", async () => {
    const res = await hcall("POST", `/api/v1/workspaces/${WS_ID}/chat-key`, { name: "chat" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      name: string;
      key_prefix: string;
      status: string;
      plaintext: string;
      purpose: string;
    };
    expect(body.purpose).toBe("chat");
    expect(body.status).toBe("enabled");
    expect(body.plaintext).toStartWith("sk-hbr-");
    expect(await dbRow(body.id)).toMatchObject({ purpose: "chat", name: "chat" });
    const verified = await verifyApiKey(db, body.plaintext);
    expect(verified).not.toBeNull();
    expect(verified!.purpose).toBe("chat");
    expect(verified!.workspace_id).toBe(WS_ID);
    // audited like key.create
    const log = await audits(body.id);
    expect(log.some((a) => a.action === "key.create")).toBe(true);
  });

  test("admin may mint; member gets 403", async () => {
    const ok = await hcall("POST", `/api/v1/workspaces/${WS_ID}/chat-key`, { name: "a" }, ADMIN_ID);
    expect(ok.status).toBe(201);
    const denied = await hcall(
      "POST",
      `/api/v1/workspaces/${WS_ID}/chat-key`,
      { name: "m" },
      MEMBER_ID,
    );
    expect(denied.status).toBe(403);
  });

  test("unauthenticated -> 401", async () => {
    const res = await app2.handle(
      new Request(`http://localhost/api/v1/workspaces/${WS_ID}/chat-key`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("ordinary /keys stays generic", () => {
  test("create response and row are purpose 'generic'; client-supplied purpose never applies", async () => {
    const res = await hcall("POST", `/api/v1/workspaces/${WS_ID}/keys`, {
      name: "plain",
      purpose: "chat",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; purpose?: string; plaintext: string };
    expect(await dbRow(body.id)).toMatchObject({ purpose: "generic" });
    const verified = await verifyApiKey(db, body.plaintext);
    expect(verified!.purpose).toBe("generic");
  });

  test("verifyApiKey returns purpose 'generic' for pre-existing keys", async () => {
    const { plaintext } = generateApiKey();
    const id = "key-legacy-generic";
    await db.insert(apiKeys).values({
      id,
      workspace_id: WS_ID,
      key_hash: hashApiKey(plaintext),
      key_prefix: "sk-hbr-l...",
      name: "legacy",
      status: "enabled",
      created_at: Date.now(),
    });
    const verified = await verifyApiKey(db, plaintext);
    expect(verified).not.toBeNull();
    expect(verified!.purpose).toBe("generic");
  });
});
