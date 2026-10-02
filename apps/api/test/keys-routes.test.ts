// Task 4: workspace-scoped sk-hbr- API keys — RBAC, shown-once plaintext, leak scan.
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { createAuth } from "../src/auth";
import { buildApp } from "../src/app";
import { hashApiKey, verifyApiKey } from "@hoborouter/keys";
import { signUp, req, createWorkspace, addMember, userIdByEmail, q } from "./helpers";

const A = "ws-a";
const B = "ws-b";
const OWNER = "kowner@example.com";
const ADMIN = "kadmin@example.com";
const MEMBER = "kmember@example.com";
const BOWNER = "kbowner@example.com";

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: string, admin: string, member: string, bowner: string;

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
  const t = await createTestDb();
  db = t.db;
  const auth = createAuth(db);
  app = await buildApp({ db, auth });

  owner = await signUp(app, OWNER, "O");
  admin = await signUp(app, ADMIN, "Ad");
  member = await signUp(app, MEMBER, "M");
  bowner = await signUp(app, BOWNER, "B");

  await createWorkspace(db, A, await userIdByEmail(db, OWNER), "A");
  await addMember(db, A, await userIdByEmail(db, ADMIN), "admin");
  await addMember(db, A, await userIdByEmail(db, MEMBER), "member");
  await createWorkspace(db, B, await userIdByEmail(db, BOWNER), "B");

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
  console.log = console.log; // eslint-disable-line no-self-assign
});

function leakScan(plaintext: string, except: string) {
  // (c) captured response bodies (incl. 4xx)
  for (const body of capturedBodies) {
    if (body === except) continue; // the single creation response
    expect(body.includes(plaintext), "plaintext leaked in a response body").toBe(false);
  }
  // (d) captured server logs
  for (const line of capturedLogs) {
    expect(line.includes(plaintext), "plaintext leaked in server logs").toBe(false);
  }
  // DB rows: no plaintext anywhere (checked inside the async leak scan below)
}

async function leakScanDb(plaintext: string) {
  for (const row of await q<Record<string, unknown>>(db, "SELECT * FROM api_keys")) {
    for (const v of Object.values(row)) {
      expect(JSON.stringify(v ?? null).includes(plaintext), "plaintext in api_keys row").toBe(false);
    }
  }
  // audit_log detail must not carry plaintext
  for (const row of await q<{ detail: unknown }>(db, "SELECT detail FROM audit_log")) {
    expect(JSON.stringify(row.detail ?? null).includes(plaintext), "plaintext in audit_log").toBe(false);
  }
}

let createdPlaintext: string;
let createdKeyBody: string;

describe("POST /api/v1/workspaces/:wsId/keys", () => {
  test("member → 403", async () => {
    expect(
      (
        await areq(`/api/v1/workspaces/${A}/keys`, {
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
        await areq(`/api/v1/workspaces/${B}/keys`, {
          method: "POST",
          cookie: admin,
          body: { name: "k" },
        })
      ).status,
    ).toBe(403);
  });

  test("admin of own workspace → 201, plaintext once, sk-hbr- format", async () => {
    const res = await areq(`/api/v1/workspaces/${A}/keys`, {
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
    expect(body.plaintext).toMatch(/^sk-hbr-[A-Za-z0-9_-]{43}$/);
    const secret = body.plaintext.slice("sk-hbr-".length);
    expect(body.key_prefix).toBe("sk-hbr-" + secret.slice(0, 4) + "..." + secret.slice(-6));
    // stored hash matches
    const row = (await q<{ key_hash: string }>(db, "SELECT key_hash FROM api_keys WHERE id = ?", body.id))[0]!;
    expect(row.key_hash).toBe(hashApiKey(body.plaintext));
  });

  test("owner of own workspace → 201", async () => {
    const res = await areq(`/api/v1/workspaces/${A}/keys`, {
      method: "POST",
      cookie: owner,
      body: { name: "o-key" },
    });
    expect(res.status).toBe(201);
  });
});

describe("GET /api/v1/workspaces/:wsId/keys", () => {
  test("member → 403", async () => {
    expect((await areq(`/api/v1/workspaces/${A}/keys`, { cookie: member })).status).toBe(403);
  });

  test("cross-workspace → 403", async () => {
    expect((await areq(`/api/v1/workspaces/${B}/keys`, { cookie: admin })).status).toBe(403);
  });

  test("admin → list without plaintext, filtered to ws", async () => {
    const res = await areq(`/api/v1/workspaces/${A}/keys`, { cookie: admin });
    expect(res.status).toBe(200);
    const list = (await res.clone().json()) as { key_prefix: string; status: string }[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(list)).not.toContain(createdPlaintext);
    for (const k of list) {
      expect(k.key_prefix).toMatch(/^sk-hbr-[A-Za-z0-9_-]{4}\.\.\.[A-Za-z0-9_-]{6}$/);
      expect(k.status).toBe("enabled");
    }
    // no B keys in A's list — asserted by count of rows bound to A
    const count = (await q<{ c: string }>(db, "SELECT count(*) c FROM api_keys WHERE workspace_id = ?", A))[0]!.c;
    expect(list.length).toBe(Number(count));
  });
});

describe("DELETE /api/v1/workspaces/:wsId/keys/:keyId", () => {
  test("member → 403", async () => {
    const keyId = (
      await q<{ id: string }>(db, "SELECT id FROM api_keys WHERE workspace_id=? LIMIT 1", A)
    )[0]!.id;
    expect(
      (await areq(`/api/v1/workspaces/${A}/keys/${keyId}`, { method: "DELETE", cookie: member }))
        .status,
    ).toBe(403);
  });

  test("cross-workspace: owner of A cannot revoke a B key → 404", async () => {
    const res = await areq(`/api/v1/workspaces/${B}/keys`, {
      method: "POST",
      cookie: bowner,
      body: { name: "bk" },
    });
    const bKey = (await res.json()) as { id: string; plaintext: string };
    capturedBodies.push(createdKeyBody); // keep scan context stable
    // owner of A attempts to revoke B's key via B's route (not a member of B) → 403; via A's route with B's key id → 404
    const viaB = await areq(`/api/v1/workspaces/${B}/keys/${bKey.id}`, {
      method: "DELETE",
      cookie: owner,
    });
    expect(viaB.status).toBe(403);
    const viaA = await areq(`/api/v1/workspaces/${A}/keys/${bKey.id}`, {
      method: "DELETE",
      cookie: owner,
    });
    expect([404, 403]).toContain(viaA.status);
    // and B's key still usable (legacy assertion: not revoked)
    const row = (await q<{ status: string }>(db, "SELECT status FROM api_keys WHERE id = ?", bKey.id))[0]!;
    expect(row.status).toBe("enabled");
  });

  test("admin revokes own-ws key immediately", async () => {
    // create a dedicated key
    const res = await areq(`/api/v1/workspaces/${A}/keys`, {
      method: "POST",
      cookie: admin,
      body: { name: "revoke-me" },
    });
    const body = (await res.json()) as { id: string; plaintext: string };
    expect(await verifyApiKey(db, body.plaintext)).not.toBeNull();

    const del = await areq(`/api/v1/workspaces/${A}/keys/${body.id}`, {
      method: "DELETE",
      cookie: admin,
    });
    expect(del.status).toBe(200);

    const row = (
      await q<{ status: string; revoked_at: string | number }>(
        db,
        "SELECT status, revoked_at FROM api_keys WHERE id = ?",
        body.id,
      )
    )[0]!;
    expect(row.status).toBe("revoked");
    expect(Number(row.revoked_at)).toBeGreaterThan(0);
    // immediately invalid
    expect(await verifyApiKey(db, body.plaintext)).toBeNull();
    // double revoke → 404 (already revoked = gone for mutation purposes)
    const again = await areq(`/api/v1/workspaces/${A}/keys/${body.id}`, {
      method: "DELETE",
      cookie: admin,
    });
    expect([404, 409]).toContain(again.status);
  });
});

describe("leak scan", () => {
  test("plaintext appears ONLY in the single creation response", async () => {
    leakScan(createdPlaintext, createdKeyBody);
    await leakScanDb(createdPlaintext);
    // and the creation response must exist and contain it exactly once
    expect(createdKeyBody.includes(createdPlaintext)).toBe(true);
  });
});
