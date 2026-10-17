// Chat attachments API + store: session+membership+owner auth, canonical
// MIME/magic validation, filename decoding, quota race, tombstone delete,
// orphan/expired GC, and DB-failure cleanup. Focused lane tests only.
import { test, expect, describe, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { chatAttachments, chatConversations } from "@hoborouter/db";
import {
  CHAT_ATTACHMENT_QUOTA_BYTES,
  CHAT_ATTACHMENT_TTL_MS,
} from "@hoborouter/shared";
import { makeApp, signUp, createWorkspace, addMember, userIdByEmail, q } from "./helpers";
import { attachmentRoutes, decodeFilename } from "../src/routes/attachments";

import {
  attachmentDir,
  attachmentPath,
  persistAttachmentFile,
  withUserLock,
  userLockCount,
} from "../src/chat-attachment-store";
import { runAttachmentGc } from "../src/attachment-gc";

// Each test file gets its own storage dir + explicit env record passed to the
// routes (never process.env mutation).
const storageRoot = mkdtempSync(join(tmpdir(), "hbr-att-"));
const avatarDir = join(storageRoot, "avatars");
mkdirSync(avatarDir, { recursive: true });
const env: Record<string, string | undefined> = {
  HBR_AVATAR_DIR: avatarDir,
  HBR_BASE_URL: "http://localhost:3000",
};

const { db, auth, app, close } = await makeApp();
const attachmentApp = new Elysia().use(attachmentRoutes(db, auth, env));

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function attReq(
  path: string,
  opts: {
    method?: string;
    cookie?: string;
    body?: BodyInit;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = { ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  return attachmentApp.handle(
    new Request("http://localhost:3000" + path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body,
    }),
  );
}

async function upload(cookie: string, wsId: string, body: BodyInit, headers: Record<string, string>) {
  return attReq(`/api/v1/workspaces/${wsId}/attachments`, {
    method: "POST",
    cookie,
    body,
    headers: { "x-hbr-filename": "file.txt", ...headers },
  });
}

const ownerCookie = await signUp(app, "att-owner@example.com");
const otherCookie = await signUp(app, "att-other@example.com");
const outsiderCookie = await signUp(app, "att-outsider@example.com");
const wsId = "ws-att-1";
const otherWsId = "ws-att-2";
await createWorkspace(db, wsId, await userIdByEmail(db, "att-owner@example.com"));
await createWorkspace(db, otherWsId, await userIdByEmail(db, "att-other@example.com"));
const ownerId = await userIdByEmail(db, "att-owner@example.com");
await addMember(db, wsId, await userIdByEmail(db, "att-other@example.com"), "member");

async function uploadText(cookie = ownerCookie, ws = wsId, content = "hello") {
  const res = await upload(cookie, ws, content, { "content-type": "text/plain" });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("upload validation", () => {
  test("accepts a small text upload and writes bytes at the UUID path", async () => {
    const { res, body } = await uploadText();
    expect(res.status).toBe(201);
    expect(body.kind).toBe("text");
    expect(body.mime).toBe("text/plain");
    expect(body.name).toBe("file.txt");
    expect(body.bytes).toBe(5);
    expect(Number(body.expires_at)).toBeGreaterThan(Date.now() + CHAT_ATTACHMENT_TTL_MS - 60_000);
    expect(body.workspace_id).toBe(wsId);
    const file = attachmentPath(attachmentDir(env), String(body.id));
    expect(existsSync(file)).toBe(true);
    expect(await Bun.file(file).text()).toBe("hello");
  });

  test("201 body has null deleted_at", async () => {
    const { body } = await uploadText(undefined, undefined, "nullcheck");
    expect(body.deleted_at).toBeNull();
  });

  test("image upload requires magic bytes matching the declared MIME", async () => {
    const ok = await upload(ownerCookie, wsId, PNG, { "content-type": "image/png" });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as Record<string, unknown>).mime).toBe("image/png");

    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 1, 2, 3, 4, 5, 6, 7, 8]);
    const bad = await upload(ownerCookie, wsId, gif, { "content-type": "image/png" });
    expect(bad.status).toBe(400);
  });

  test("rejects non-allowlisted content types with 415", async () => {
    const res = await upload(ownerCookie, wsId, "<h1>x</h1>", { "content-type": "text/html" });
    expect(res.status).toBe(415);
  });

  test("rejects text containing NUL bytes and invalid UTF-8 with 400", async () => {
    const nul = await upload(ownerCookie, wsId, "a\u0000b", { "content-type": "text/plain" });
    expect(nul.status).toBe(400);
    const invalid = await upload(ownerCookie, wsId, new Uint8Array([0xff, 0xfe, 0x00]), {
      "content-type": "text/plain",
    });
    expect(invalid.status).toBe(400);
  });

  test("rejects oversized text (64 KiB cap) and oversized images with 413", async () => {
    const bigText = await upload(ownerCookie, wsId, "x".repeat(64 * 1024 + 1), {
      "content-type": "text/plain",
    });
    expect(bigText.status).toBe(413);
    const bigImage = await upload(ownerCookie, wsId, new Uint8Array(10 * 1024 * 1024 + 1), {
      "content-type": "image/png",
    });
    expect(bigImage.status).toBe(413);
  });

  test("filename is percent-decoded once; malformed, slash, and control names are 400", async () => {
    const ok = await upload(ownerCookie, wsId, "f", {
      "content-type": "text/plain",
      "x-hbr-filename": "%E4%BD%A0%E5%A5%BD.txt",
    });
    expect(((await ok.json()) as Record<string, unknown>).name).toBe("你好.txt");

    // \0 can never survive an HTTP header; the control-char rejection is
    // covered directly on decodeFilename below.
    for (const name of ["%zz.txt", "a/b.txt", "a\\b.txt", ""]) {
      const res = await upload(ownerCookie, wsId, "f", {
        "content-type": "text/plain",
        "x-hbr-filename": name,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("auth boundary", () => {
  test("401 without a session; Bearer tokens never grant access", async () => {
    const noCookie = await uploadText("", undefined);
    expect(noCookie.res.status).toBe(401);
    const bearer = await attReq(`/api/v1/workspaces/${wsId}/attachments`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-hbr-anything",
        "content-type": "text/plain",
        "x-hbr-filename": "f.txt",
      },
      body: "x",
    });
    expect(bearer.status).toBe(401);
  });

  test("403 for a non-member of the workspace", async () => {
    const res = await uploadText(outsiderCookie);
    expect(res.res.status).toBe(403);
  });

  test("GET/DELETE of another member's attachment is 404, even in the same workspace", async () => {
    const { body } = await uploadText();
    const id = String(body.id);
    expect((await attReq(`/api/v1/workspaces/${wsId}/attachments/${id}`, { cookie: otherCookie })).status).toBe(404);
    expect(
      await attReq(`/api/v1/workspaces/${wsId}/attachments/${id}`, { method: "DELETE", cookie: otherCookie }),
    ).toMatchObject({ status: 404 });
    // A different workspace the requester belongs to: still 404 (not a leak).
    expect((await attReq(`/api/v1/workspaces/${otherWsId}/attachments/${id}`, { cookie: otherCookie })).status).toBe(404);
  });

  test("unsafe methods reject cross-site Origin but accept the configured trusted origin", async () => {
    const evil = await upload(ownerCookie, wsId, "x", {
      "content-type": "text/plain",
      origin: "https://evil.example",
    });
    expect(evil.status).toBe(403);
    const trusted = await upload(ownerCookie, wsId, "x", {
      "content-type": "text/plain",
      origin: "http://localhost:3000",
    });
    expect(trusted.status).toBe(201);
    const evilDelete = await attReq(`/api/v1/workspaces/${wsId}/attachments/00000000-0000-4000-8000-000000000000`, {
      method: "DELETE",
      cookie: ownerCookie,
      headers: { origin: "https://evil.example" },
    });
    expect(evilDelete.status).toBe(403);
  });
});

describe("download + delete lifecycle", () => {
  test("GET refuses an owned attachment path that is a symlink", async () => {
    const { body } = await uploadText(undefined, undefined, "original");
    const id = String(body.id);
    const target = join(storageRoot, "outside.txt");
    writeFileSync(target, "secret target bytes");
    const path = attachmentPath(attachmentDir(env), id);
    rmSync(path);
    symlinkSync(target, path);

    const res = await attReq(`/api/v1/workspaces/${wsId}/attachments/${id}`, { cookie: ownerCookie });
    expect(res.status).toBe(410);
    expect(await res.text()).not.toContain("secret target bytes");
  });

  test("GET returns the exact bytes with no-store/nosniff/safe disposition", async () => {
    const { body } = await uploadText(undefined, undefined, "roundtrip");
    const res = await attReq(`/api/v1/workspaces/${wsId}/attachments/${String(body.id)}`, {
      cookie: ownerCookie,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("roundtrip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).not.toContain("<");
  });

  test("expired own attachment is 410; metadata row is retained", async () => {
    const { body } = await uploadText(undefined, undefined, "expired");
    const id = String(body.id);
    await db
      .update(chatAttachments)
      .set({ expires_at: Date.now() - 1 })
      .where(eq(chatAttachments.id, id));
    expect((await attReq(`/api/v1/workspaces/${wsId}/attachments/${id}`, { cookie: ownerCookie })).status).toBe(410);
    const row = (await q<{ deleted_at: number | null }>(db, "SELECT deleted_at FROM chat_attachments WHERE id = ?", id)).at(0);
    expect(row).toBeDefined();
    expect(row!.deleted_at).toBeNull(); // expired != deleted; GC will tombstone
  });

  test("DELETE is idempotent: tombstones once, unlinks bytes, always 200 for the owner", async () => {
    const { body } = await uploadText(undefined, undefined, "deleteme");
    const id = String(body.id);
    const file = attachmentPath(attachmentDir(env), id);
    expect(existsSync(file)).toBe(true);
    expect(
      await attReq(`/api/v1/workspaces/${wsId}/attachments/${id}`, { method: "DELETE", cookie: ownerCookie }),
    ).toMatchObject({ status: 200 });
    expect(existsSync(file)).toBe(false);
    // Idempotent retry after the file is already gone.
    expect(
      await attReq(`/api/v1/workspaces/${wsId}/attachments/${id}`, { method: "DELETE", cookie: ownerCookie }),
    ).toMatchObject({ status: 200 });
    expect((await attReq(`/api/v1/workspaces/${wsId}/attachments/${id}`, { cookie: ownerCookie })).status).toBe(410);
    const row2 = (await q<{ deleted_at: number | null }>(db, "SELECT deleted_at FROM chat_attachments WHERE id = ?", id)).at(0);
    expect(row2!.deleted_at).not.toBeNull();
  });

  test("path-like attachment ids never touch the filesystem (404)", async () => {
    const res = await attReq(`/api/v1/workspaces/${wsId}/attachments/..%2F..%2Fetc%2Fpasswd`, {
      cookie: ownerCookie,
    });
    expect(res.status).toBe(404);
  });
});

describe("quota", () => {
  test("concurrent uploads that together exceed 500 MiB cannot both succeed", async () => {
    // Seed live usage to QUOTA - 9000 via rows (DB caps each row at 10 MiB,
    // so the total is built from 49 full rows + one filler row). Only one
    // 5000-byte upload fits; the second must 413.
    const seedBytes = 10 * 1024 * 1024;
    const filler = CHAT_ATTACHMENT_QUOTA_BYTES - 9000 - 49 * seedBytes;
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      await db.insert(chatAttachments).values({
        id: crypto.randomUUID(),
        user_id: ownerId,
        workspace_id: wsId,
        kind: "text",
        name: `seed-${i}.txt`,
        mime: "text/plain",
        bytes: i < 49 ? seedBytes : filler,
        created_at: now,
        expires_at: now + CHAT_ATTACHMENT_TTL_MS,
      });
    }
    const body5k = "y".repeat(5000);
    const [a, b] = await Promise.all([
      uploadText(ownerCookie, undefined, body5k),
      uploadText(ownerCookie, undefined, body5k),
    ]);
    const statuses = [a.res.status, b.res.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 413]);
    const live = await q<{ total: number }>(
      db,
      "SELECT coalesce(sum(bytes),0) as total FROM chat_attachments WHERE user_id = ? AND deleted_at IS NULL",
      ownerId,
    );
    expect(live[0]!.total).toBeLessThanOrEqual(CHAT_ATTACHMENT_QUOTA_BYTES);
  });
});

describe("GC", () => {
  test("orphans older than 24h are tombstoned + unlinked; referenced rows are kept; expired rows always die", async () => {
    const dir = attachmentDir(env);
    const old = Date.now() - 25 * 60 * 60 * 1000;
    const orphanId = crypto.randomUUID();
    await db.insert(chatAttachments).values({
      id: orphanId,
      user_id: ownerId,
      workspace_id: wsId,
      kind: "text",
      name: "orphan.txt",
      mime: "text/plain",
      bytes: 10,
      created_at: old,
      expires_at: Date.now() + CHAT_ATTACHMENT_TTL_MS,
    });
    const referencedId = crypto.randomUUID();
    await db.insert(chatAttachments).values({
      id: referencedId,
      user_id: ownerId,
      workspace_id: wsId,
      kind: "text",
      name: "kept.txt",
      mime: "text/plain",
      bytes: 10,
      created_at: old,
      expires_at: Date.now() + CHAT_ATTACHMENT_TTL_MS,
    });
    const expiredId = crypto.randomUUID();
    await db.insert(chatAttachments).values({
      id: expiredId,
      user_id: ownerId,
      workspace_id: wsId,
      kind: "text",
      name: "expired.txt",
      mime: "text/plain",
      bytes: 10,
      created_at: old,
      expires_at: Date.now() - 1,
    });
    for (const id of [orphanId, referencedId, expiredId])
      writeFileSync(attachmentPath(dir, id), "bytes");

    // A current conversation jsonb references kept.txt (reference truth = the
    // conversation store, not a client claim).
    await db.insert(chatConversations).values({
      id: crypto.randomUUID(),
      user_id: ownerId,
      workspace_id: wsId,
      title: "t",
      messages: [{ role: "user", content: "see file", attachments: [{ id: referencedId, name: "kept.txt", kind: "text", bytes: 10, mime: "text/plain", expires_at: Date.now() + 1000 }] }],
      version: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const result = await runAttachmentGc(db, env);
    expect(result.orphaned).toBeGreaterThanOrEqual(1);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(existsSync(attachmentPath(dir, orphanId))).toBe(false);
    expect(existsSync(attachmentPath(dir, referencedId))).toBe(true);
    expect(existsSync(attachmentPath(dir, expiredId))).toBe(false);
    // Tombstones: orphans/expired are deleted_at-set; the referenced row stays live.
    for (const [id, wantDeleted] of [
      [orphanId, true],
      [referencedId, false],
      [expiredId, true],
    ] as const) {
      const r = (
        await q<{ deleted_at: number | null }>(
          db,
          "SELECT deleted_at FROM chat_attachments WHERE id = ?",
          id,
        )
      ).at(0);
      expect(!!r!.deleted_at).toBe(wantDeleted);
    }
  });
});

describe("store internals", () => {
  test("decodeFilename rejects control characters (NUL cannot ride an HTTP header)", () => {
    expect(decodeFilename("a\u0000b")).toBeNull();
    expect(decodeFilename("a\nb")).toBeNull();
    expect(decodeFilename("ok-name.txt")).toBe("ok-name.txt");
  });

  test("persistAttachmentFile cleans the temp file when the DB commit fails", async () => {
    const dir = attachmentDir(env);
    const id = crypto.randomUUID();
    await expect(
      persistAttachmentFile(dir, id, new Uint8Array([1, 2, 3]), async () => {
        throw new Error("db constraint");
      }),
    ).rejects.toThrow("db constraint");
    expect(existsSync(join(dir, `${id}.tmp`))).toBe(false);
    expect(existsSync(attachmentPath(dir, id))).toBe(false);
  });

  test("temp file is mode 0600 and created exclusively", async () => {
    const dir = attachmentDir(env);
    const id = crypto.randomUUID();
    await persistAttachmentFile(dir, id, new Uint8Array([1]), async (finalize) => {
      finalize();
      return "ok";
    });
    expect(statSync(attachmentPath(dir, id)).mode & 0o777).toBe(0o600);

    const collision = crypto.randomUUID();
    const tempPath = join(dir, `${collision}.tmp`);
    writeFileSync(tempPath, "do not overwrite");
    await expect(persistAttachmentFile(dir, collision, new Uint8Array([2]), async () => "ok")).rejects.toThrow();
    expect(readFileSync(tempPath, "utf8")).toBe("do not overwrite");
    expect(existsSync(attachmentPath(dir, collision))).toBe(false);
  });

  test("cleans temp and final paths when commit or rename fails", async () => {
    const dir = attachmentDir(env);
    const commitId = crypto.randomUUID();
    await expect(persistAttachmentFile(dir, commitId, new Uint8Array([1]), async () => {
      throw new Error("commit failed");
    })).rejects.toThrow("commit failed");
    expect(existsSync(join(dir, `${commitId}.tmp`))).toBe(false);
    expect(existsSync(attachmentPath(dir, commitId))).toBe(false);

    const renameId = crypto.randomUUID();
    mkdirSync(attachmentPath(dir, renameId));
    await expect(persistAttachmentFile(dir, renameId, new Uint8Array([1]), async (finalize) => {
      finalize();
      return "ok";
    })).rejects.toThrow();
    expect(existsSync(join(dir, `${renameId}.tmp`))).toBe(false);

    const rollbackId = crypto.randomUUID();
    await expect(persistAttachmentFile(dir, rollbackId, new Uint8Array([1]), async (finalize) => {
      finalize();
      throw new Error("transaction commit failed");
    })).rejects.toThrow("transaction commit failed");
    expect(existsSync(join(dir, `${rollbackId}.tmp`))).toBe(false);
    expect(existsSync(attachmentPath(dir, rollbackId))).toBe(false);
  });

  test("withUserLock serializes per user", async () => {
    const order: string[] = [];
    await Promise.all([
      withUserLock("u1", async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("a");
      }),
      withUserLock("u1", async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["a", "b"]);
    expect(userLockCount()).toBe(0);
  });

  test("withUserLock drains tails after rejection and permits reuse", async () => {
    await expect(withUserLock("rejecting", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(userLockCount()).toBe(0);
    await expect(withUserLock("rejecting", async () => "reused")).resolves.toBe("reused");
    expect(userLockCount()).toBe(0);
  });
});

afterAll(() => {
  rmSync(storageRoot, { recursive: true, force: true });
  return close();
});
