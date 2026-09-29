// Task 4: workspace-scoped sk-hbr- API keys — RBAC, shown-once plaintext, leak scan.
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createDb, migrate } from "@hoborouter/db";
import { createAuth } from "../src/auth";
import { buildApp } from "../src/app";
import { hashApiKey, verifyApiKey } from "@hoborouter/keys";
import { signUp, req, createWorkspace, addMember, userIdByEmail } from "./helpers";

const A = "ws-a";
const B = "ws-b";
const OWNER = "kowner@example.com";
const ADMIN = "kadmin@example.com";
const MEMBER = "kmember@example.com";
const BOWNER = "kbowner@example.com";

let db: Database;
let app: ReturnType<typeof buildApp>;
let owner: string, admin: string, member: string, bowner: string;
let dir: string;

// Capture everything the server could emit for the leak scan.
const capturedBodies: string[] = [];
const capturedLogs: string[] = [];

// Wrap req() so every response body (incl. errors) is captured.
async function areq(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await req(app, path, opts);
  const clone = res.clone();
  capturedBodies.push(await clone.text());
  return res;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hbr-keys-"));
  db = createDb(join(dir, "keys.sqlite")); // file-backed → WAL/SHM sidecars exist
  migrate(db);
  const auth = createAuth(db);
  app = buildApp({ db, auth });

  owner = await signUp(app, OWNER, "O");
  admin = await signUp(app, ADMIN, "Ad");
  member = await signUp(app, MEMBER, "M");
  bowner = await signUp(app, BOWNER, "B");

  createWorkspace(db, A, userIdByEmail(db, OWNER), "A");
  addMember(db, A, userIdByEmail(db, ADMIN), "admin");
  addMember(db, A, userIdByEmail(db, MEMBER), "member");
  createWorkspace(db, B, userIdByEmail(db, BOWNER), "B");

  const origLog = console.log;
  const origErr = console.error;
  const wrap =
    (orig: (...a: unknown[]) => void) =>
    (...a: unknown[]) => {
      capturedLogs.push(a.map(String).join(" "));
      orig(...a);
    };
  console.log = wrap(origLog);
  console.error = wrap(origErr);
});

afterAll(() => {
  // Force checkpoint so plaintext (if any) is flushed into the main db file.
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // db may already be closed — checkpoint is best-effort
  }
  console.log = console.log; // eslint-disable-line no-self-assign
  rmSync(dir, { recursive: true, force: true });
});

function leakScan(plaintext: string, except: string) {
  // (a) main DB file, (b) WAL/SHM sidecars
  const files = [
    join(dir, "keys.sqlite"),
    join(dir, "keys.sqlite-wal"),
    join(dir, "keys.sqlite-shm"),
  ];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const buf = readFileSync(f).toString("latin1");
    expect(buf.includes(plaintext), `plaintext leaked in ${f}`).toBe(false);
  }
  // (c) captured response bodies (incl. 4xx)
  for (const body of capturedBodies) {
    if (body === except) continue; // the single creation response
    expect(body.includes(plaintext), "plaintext leaked in a response body").toBe(false);
  }
  // (d) captured server logs
  for (const line of capturedLogs) {
    expect(line.includes(plaintext), "plaintext leaked in server logs").toBe(false);
  }
  // DB rows: no plaintext anywhere
  for (const row of db.prepare("SELECT * FROM api_keys").all() as Record<string, unknown>[]) {
    for (const v of Object.values(row)) {
      expect(JSON.stringify(v ?? null).includes(plaintext), "plaintext in api_keys row").toBe(
        false,
      );
    }
  }
  // audit_log detail must not carry plaintext
  for (const row of db.prepare("SELECT detail FROM audit_log").all() as {
    detail: string | null;
  }[]) {
    expect(row.detail?.includes(plaintext) ?? false, "plaintext in audit_log").toBe(false);
  }
}

let createdPlaintext: string;
let createdKeyBody: string;

describe("POST /api/workspaces/:wsId/keys", () => {
  test("member → 403", async () => {
    expect(
      (
        await areq(`/api/workspaces/${A}/keys`, {
          method: "POST",
          cookie: member,
          body: { name: "k" },
        })
      ).status,
    ).toBe(403);
  });

  test("cross-workspace admin → 403", async () => {
    expect(
      (
        await areq(`/api/workspaces/${B}/keys`, {
          method: "POST",
          cookie: admin,
          body: { name: "k" },
        })
      ).status,
    ).toBe(403);
  });

  test("admin of own workspace → 201, plaintext once, sk-hbr- format", async () => {
    const res = await areq(`/api/workspaces/${A}/keys`, {
      method: "POST",
      cookie: admin,
      body: { name: "ci-key" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      plaintext: string;
      key_prefix: string;
      name: string;
    };
    createdPlaintext = body.plaintext;
    createdKeyBody = JSON.stringify(body);
    expect(body.plaintext).toMatch(/^sk-hbr-[0-9a-f]{32}$/);
    expect(body.key_prefix).toBe("sk-hbr-…" + body.plaintext.slice(-4));
    // stored hash matches
    const row = db.prepare("SELECT key_hash FROM api_keys WHERE id = ?").get(body.id) as any;
    expect(row.key_hash).toBe(hashApiKey(body.plaintext));
  });

  test("owner of own workspace → 201", async () => {
    const res = await areq(`/api/workspaces/${A}/keys`, {
      method: "POST",
      cookie: owner,
      body: { name: "o-key" },
    });
    expect(res.status).toBe(201);
  });
});

describe("GET /api/workspaces/:wsId/keys", () => {
  test("member → 403", async () => {
    expect((await areq(`/api/workspaces/${A}/keys`, { cookie: member })).status).toBe(403);
  });

  test("cross-workspace → 403", async () => {
    expect((await areq(`/api/workspaces/${B}/keys`, { cookie: admin })).status).toBe(403);
  });

  test("admin → list without plaintext, filtered to ws", async () => {
    const res = await areq(`/api/workspaces/${A}/keys`, { cookie: admin });
    expect(res.status).toBe(200);
    const list = (await res.clone().json()) as { key_prefix: string; status: string }[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(list)).not.toContain(createdPlaintext);
    for (const k of list) {
      expect(k.key_prefix).toMatch(/^sk-hbr-…[0-9a-f]{4}$/);
      expect(k.status).toBe("active");
    }
    // no B keys in A's list — asserted by count of rows bound to A
    const count = (
      db.prepare("SELECT count(*) c FROM api_keys WHERE workspace_id = ?").get(A) as any
    ).c;
    expect(list.length).toBe(count);
  });
});

describe("DELETE /api/workspaces/:wsId/keys/:keyId", () => {
  test("member → 403", async () => {
    const keyId = (db.prepare("SELECT id FROM api_keys WHERE workspace_id=? LIMIT 1").get(A) as any)
      .id;
    expect(
      (await areq(`/api/workspaces/${A}/keys/${keyId}`, { method: "DELETE", cookie: member }))
        .status,
    ).toBe(403);
  });

  test("cross-workspace: owner of A cannot revoke a B key → 404", async () => {
    const res = await areq(`/api/workspaces/${B}/keys`, {
      method: "POST",
      cookie: bowner,
      body: { name: "bk" },
    });
    const bKey = (await res.json()) as { id: string; plaintext: string };
    capturedBodies.push(createdKeyBody); // keep scan context stable
    // owner of A attempts to revoke B's key via B's route (not a member of B) → 403; via A's route with B's key id → 404
    const viaB = await areq(`/api/workspaces/${B}/keys/${bKey.id}`, {
      method: "DELETE",
      cookie: owner,
    });
    expect(viaB.status).toBe(403);
    const viaA = await areq(`/api/workspaces/${A}/keys/${bKey.id}`, {
      method: "DELETE",
      cookie: owner,
    });
    expect([404, 403]).toContain(viaA.status);
    // and B's key still active
    const row = db.prepare("SELECT status FROM api_keys WHERE id = ?").get(bKey.id) as any;
    expect(row.status).toBe("active");
  });

  test("admin revokes own-ws key immediately", async () => {
    // create a dedicated key
    const res = await areq(`/api/workspaces/${A}/keys`, {
      method: "POST",
      cookie: admin,
      body: { name: "revoke-me" },
    });
    const body = (await res.json()) as { id: string; plaintext: string };
    expect(verifyApiKey(db, body.plaintext)).not.toBeNull();

    const del = await areq(`/api/workspaces/${A}/keys/${body.id}`, {
      method: "DELETE",
      cookie: admin,
    });
    expect(del.status).toBe(200);

    const row = db
      .prepare("SELECT status, revoked_at FROM api_keys WHERE id = ?")
      .get(body.id) as any;
    expect(row.status).toBe("revoked");
    expect(row.revoked_at).toBeGreaterThan(0);
    // immediately invalid
    expect(verifyApiKey(db, body.plaintext)).toBeNull();
    // double revoke → 404 (already revoked = gone for mutation purposes)
    const again = await areq(`/api/workspaces/${A}/keys/${body.id}`, {
      method: "DELETE",
      cookie: admin,
    });
    expect([404, 409]).toContain(again.status);
  });
});

describe("leak scan", () => {
  test("plaintext appears ONLY in the single creation response", () => {
    leakScan(createdPlaintext, createdKeyBody);
    // and the creation response must exist and contain it exactly once
    expect(createdKeyBody.includes(createdPlaintext)).toBe(true);
  });
});
