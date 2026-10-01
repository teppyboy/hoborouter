// Key lifecycle: PATCH status transitions + model restrictions (api_key_model_permissions).
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createDb, migrate } from "@hoborouter/db";
import { createAuth } from "../src/auth";
import { buildApp } from "../src/app";
import { req, createWorkspace, addMember, userIdByEmail } from "./helpers";

const A = "ws-lc-a";
const B = "ws-lc-b";
const OWNER = "lcowner@example.com";
const MEMBER = "lcmember@example.com";
const BOWNER = "lcbowner@example.com";

let db: Database;
let app: ReturnType<typeof buildApp>;
let owner: string, member: string, bowner: string;
let dir: string;

const A_KEY_MODEL = "openai/gpt-x";
const A_KEY_MODEL_2 = "anthropic/claude-x";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hbr-keyslc-"));
  db = createDb(join(dir, "keyslc.sqlite"));
  migrate(db);
  const auth = createAuth(db);
  app = buildApp({ db, auth });

  owner = await signUpLocal(OWNER, "O");
  member = await signUpLocal(MEMBER, "M");
  bowner = await signUpLocal(BOWNER, "B");
  createWorkspace(db, A, userIdByEmail(db, OWNER), "A");
  addMember(db, A, userIdByEmail(db, MEMBER), "member");
  createWorkspace(db, B, userIdByEmail(db, BOWNER), "B");
  // seed catalog
  for (const m of [A_KEY_MODEL, A_KEY_MODEL_2, "google/gemini-x"]) {
    db.prepare(
      "INSERT INTO models (id, public_id, slug, display_name, provider, created_at, updated_at) VALUES (?,?,?,?,'p',1,1)",
    ).run(m, m, m, m);
  }
});

async function signUpLocal(email: string, name: string): Promise<string> {
  const res = await req(app, "/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: "correct horse battery staple", name },
  });
  if (!res.ok) throw new Error(`signup failed ${res.status}`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function makeKey(ws: string, cookie: string, name: string) {
  const res = await req(app, `/api/v1/workspaces/${ws}/keys`, {
    method: "POST",
    cookie,
    body: { name },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    id: string;
    plaintext: string;
    key_prefix: string;
    status?: string;
  };
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("POST keys — enabled status + new prefix format", () => {
  test("new key created with status 'enabled'", async () => {
    const body = await makeKey(A, owner, "st");
    const row = db.prepare("SELECT status FROM api_keys WHERE id = ?").get(body.id) as any;
    expect(row.status).toBe("enabled");
  });

  test("create response status is 'enabled'; key_prefix is new display format", async () => {
    const body = await makeKey(A, owner, "fmt");
    expect(body.status).toBe("enabled");
    const secret = body.plaintext.slice("sk-hbr-".length);
    expect(body.key_prefix).toBe("sk-hbr-" + secret.slice(0, 4) + "..." + secret.slice(-6));
  });
});

describe("GET keys — legacy 'active' normalized to 'enabled'", () => {
  test("legacy active row listed as 'enabled'", () => {
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES (?,?,?,'pfx','legacy','active',1)",
    ).run(id, A, "legacy-hash-" + id);
  });

  test("list shows normalized statuses", async () => {
    const res = await req(app, `/api/v1/workspaces/${A}/keys`, { cookie: owner });
    const list = (await res.json()) as { status: string }[];
    for (const k of list) expect(k.status).toBe("enabled");
  });
});

describe("PATCH /api/v1/workspaces/:id/keys/:keyId", () => {
  test("member → 403", async () => {
    const k = await makeKey(A, owner, "pm");
    const res = await req(app, `/api/v1/workspaces/${A}/keys/${k.id}`, {
      method: "PATCH",
      cookie: member,
      body: { status: "disabled" },
    });
    expect(res.status).toBe(403);
  });

  test("cross-workspace key → 404", async () => {
    const k = await makeKey(A, owner, "xws");
    const res = await req(app, `/api/v1/workspaces/${B}/keys/${k.id}`, {
      method: "PATCH",
      cookie: bowner,
      body: { status: "disabled" },
    });
    expect(res.status).toBe(404);
  });

  test("invalid status value → 400", async () => {
    const k = await makeKey(A, owner, "inv");
    const res = await req(app, `/api/v1/workspaces/${A}/keys/${k.id}`, {
      method: "PATCH",
      cookie: owner,
      body: { status: "active" },
    });
    expect(res.status).toBe(400);
  });

  test("enabled → disabled → enabled", async () => {
    const k = await makeKey(A, owner, "cycle");
    const d = await req(app, `/api/v1/workspaces/${A}/keys/${k.id}`, {
      method: "PATCH",
      cookie: owner,
      body: { status: "disabled" },
    });
    expect(d.status).toBe(200);
    expect((db.prepare("SELECT status FROM api_keys WHERE id=?").get(k.id) as any).status).toBe(
      "disabled",
    );
    const e = await req(app, `/api/v1/workspaces/${A}/keys/${k.id}`, {
      method: "PATCH",
      cookie: owner,
      body: { status: "enabled" },
    });
    expect(e.status).toBe(200);
    expect((db.prepare("SELECT status FROM api_keys WHERE id=?").get(k.id) as any).status).toBe(
      "enabled",
    );
  });

  test("revoked is terminal: 409 on disable/enable of revoked", async () => {
    const k = await makeKey(A, owner, "term");
    await req(app, `/api/v1/workspaces/${A}/keys/${k.id}`, { method: "DELETE", cookie: owner });
    for (const status of ["disabled", "enabled"]) {
      const res = await req(app, `/api/v1/workspaces/${A}/keys/${k.id}`, {
        method: "PATCH",
        cookie: owner,
        body: { status },
      });
      expect(res.status).toBe(409);
    }
    const row = db.prepare("SELECT status FROM api_keys WHERE id=?").get(k.id) as any;
    expect(row.status).toBe("revoked");
  });

  test("audit rows written for key.disable / key.enable", async () => {
    const k = await makeKey(A, owner, "aud");
    await req(app, `/api/v1/workspaces/${A}/keys/${k.id}`, {
      method: "PATCH",
      cookie: owner,
      body: { status: "disabled" },
    });
    await req(app, `/api/v1/workspaces/${A}/keys/${k.id}`, {
      method: "PATCH",
      cookie: owner,
      body: { status: "enabled" },
    });
    const actions = (
      db.prepare("SELECT action FROM audit_log WHERE target = ? ORDER BY id").all(k.id) as any[]
    ).map((r) => r.action);
    expect(actions).toContain("key.disable");
    expect(actions).toContain("key.enable");
  });
});

describe("model restrictions GET/PUT /api/v1/workspaces/:id/keys/:keyId/models", () => {
  test("member → 403", async () => {
    const k = await makeKey(A, owner, "mperm");
    const res = await req(app, `/api/v1/workspaces/${A}/keys/${k.id}/models`, { cookie: member });
    expect(res.status).toBe(403);
  });

  test("cross-workspace key → 404", async () => {
    const k = await makeKey(A, owner, "mperm-x");
    const res = await req(app, `/api/v1/workspaces/${B}/keys/${k.id}/models`, { cookie: bowner });
    expect(res.status).toBe(404);
  });

  test("default (no rows) → modelIds [] meaning unrestricted", async () => {
    const k = await makeKey(A, owner, "mfree");
    const res = await req(app, `/api/v1/workspaces/${A}/keys/${k.id}/models`, { cookie: owner });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modelIds: string[] };
    expect(body.modelIds).toEqual([]);
  });

  test("PUT replaces set atomically; GET returns it", async () => {
    const k = await makeKey(A, owner, "mset");
    const put = await req(app, `/api/v1/workspaces/${A}/keys/${k.id}/models`, {
      method: "PUT",
      cookie: owner,
      body: { modelIds: [A_KEY_MODEL, A_KEY_MODEL_2, A_KEY_MODEL] }, // dup removed
    });
    expect(put.status).toBe(200);
    const get = await req(app, `/api/v1/workspaces/${A}/keys/${k.id}/models`, { cookie: owner });
    const body = (await get.json()) as { modelIds: string[] };
    expect(body.modelIds.sort()).toEqual([A_KEY_MODEL, A_KEY_MODEL_2].sort());
    const rows = db
      .prepare("SELECT model_id FROM api_key_model_permissions WHERE api_key_id = ?")
      .all(k.id) as any[];
    expect(rows.length).toBe(2);
  });

  test("PUT with unknown model id → 400, set unchanged", async () => {
    const k = await makeKey(A, owner, "mbad");
    await req(app, `/api/v1/workspaces/${A}/keys/${k.id}/models`, {
      method: "PUT",
      cookie: owner,
      body: { modelIds: [A_KEY_MODEL] },
    });
    const put = await req(app, `/api/v1/workspaces/${A}/keys/${k.id}/models`, {
      method: "PUT",
      cookie: owner,
      body: { modelIds: [A_KEY_MODEL, "nope/unknown"] },
    });
    expect(put.status).toBe(400);
    const rows = db
      .prepare("SELECT model_id FROM api_key_model_permissions WHERE api_key_id = ?")
      .all(k.id) as any[];
    expect(rows.length).toBe(1);
  });

  test("PUT [] clears restrictions → unrestricted", async () => {
    const k = await makeKey(A, owner, "mclear");
    await req(app, `/api/v1/workspaces/${A}/keys/${k.id}/models`, {
      method: "PUT",
      cookie: owner,
      body: { modelIds: [A_KEY_MODEL] },
    });
    const put = await req(app, `/api/v1/workspaces/${A}/keys/${k.id}/models`, {
      method: "PUT",
      cookie: owner,
      body: { modelIds: [] },
    });
    expect(put.status).toBe(200);
    const rows = db
      .prepare("SELECT model_id FROM api_key_model_permissions WHERE api_key_id = ?")
      .all(k.id) as any[];
    expect(rows.length).toBe(0);
  });

  test("audit key.models.set written", async () => {
    const k = await makeKey(A, owner, "maud");
    await req(app, `/api/v1/workspaces/${A}/keys/${k.id}/models`, {
      method: "PUT",
      cookie: owner,
      body: { modelIds: [A_KEY_MODEL] },
    });
    const actions = (
      db.prepare("SELECT action FROM audit_log WHERE target = ?").all(k.id) as any[]
    ).map((r) => r.action);
    expect(actions).toContain("key.models.set");
  });

  test("audit detail carries no plaintext or hash", async () => {
    const k = await makeKey(A, owner, "msec");
    const detail = (
      db
        .prepare("SELECT detail FROM audit_log WHERE target = ? AND action='key.create'")
        .get(k.id) as any
    ).detail as string;
    expect(detail).not.toContain(k.plaintext);
    expect(detail).not.toMatch(/^[0-9a-f]{64}$/);
  });
});
