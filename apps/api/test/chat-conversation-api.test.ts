// Conversation lane additions (apps/api/src/routes/chats.ts): PUT /title,
// POST /fork, GET list ?q search, and canonical attachment-ref handling in
// PUT. Standalone route contract tests (same harness shape as chats.test.ts).
// Covers: conditional rename (stale 409, transcript unchanged), full-snapshot
// fork (source intact, prefix through user turn, grandfathered refs), honest
// filtered keyset search (LIKE escaping), metadata forgery rejection, and
// all-or-nothing ref validation.
import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { afterAll, describe, expect, test } from "bun:test";
import { createAuth } from "../src/auth";
import { chatsRoutes } from "../src/routes/chats";
import { sql } from "drizzle-orm";

const openDbs: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of openDbs) await close();
});

async function makeCtx() {
  const t = await createTestDb();
  openDbs.push(t.drop);
  const db = t.db;
  const auth = createAuth(db);
  const authHandler = (ctx: { request: Request }) => auth.handler(ctx.request);
  const app = new Elysia({ name: "chat-conversation-api-test" })
    .get("/api/auth/*", authHandler)
    .all("/api/auth/*", authHandler)
    .use(chatsRoutes(db, auth));

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

  const cookies = new Map<string, string>();
  const cookie = async (email: string) => {
    const hit = cookies.get(email);
    if (hit) return hit;
    const res = await app.handle(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password: "Correct-Horse-Battery-Staple-1",
          name: email,
        }),
      }),
    );
    if (!res.ok && res.status !== 422) {
      throw new Error(`signup failed ${res.status}: ${await res.text()}`);
    }
    const c =
      res.ok && res.headers.getSetCookie().length
        ? cookieOf(res)
        : cookieOf(
            await app.handle(
              new Request("http://localhost/api/auth/sign-in/email", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, password: "Correct-Horse-Battery-Staple-1" }),
              }),
            ),
          );
    cookies.set(email, c);
    return c;
  };

  const userId = async (email: string) => {
    const res = (await db.execute(
      sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`,
    )) as unknown as { id: string }[];
    if (!res[0]) throw new Error("no user " + email);
    return res[0].id;
  };

  return { db, app, cookie, userId };
}

type TestCtx = Awaited<ReturnType<typeof makeCtx>>;

type HandleLike = { handle: (req: Request) => Promise<Response> };
const req = (
  app: HandleLike,
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown } = {},
) => {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app.handle(
    new Request("http://localhost" + path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );
};

const seedWorkspace = async (db: Db, wsId: string, ownerId: string) => {
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at) VALUES (${wsId}, ${wsId}, 'active', ${Date.now()})`,
  );
  await db.execute(
    sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${ownerId}, 'owner')`,
  );
};

const addMember = async (db: Db, wsId: string, userId: string, role: string) => {
  await db.execute(
    sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${userId}, ${role})`,
  );
};

const createChat = async (ctx: TestCtx, wsId: string, cookie: string) => {
  const res = await req(ctx.app, `/api/v1/workspaces/${wsId}/chats`, {
    method: "POST",
    cookie,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
};

const seedAttachment = async (
  db: Db,
  opts: {
    id: string;
    userId: string;
    wsId: string;
    name?: string;
    mime?: string;
    bytes?: number;
    expiresAt?: number;
    deletedAt?: number | null;
  },
) => {
  await db.execute(
    sql`INSERT INTO chat_attachments (id, user_id, workspace_id, kind, name, mime, bytes, created_at, expires_at, deleted_at)
        VALUES (${opts.id}, ${opts.userId}, ${opts.wsId}, 'image', ${opts.name ?? "real.png"},
                ${opts.mime ?? "image/png"}, ${opts.bytes ?? 1234}, ${Date.now()},
                ${opts.expiresAt ?? Date.now() + 86400_000}, ${opts.deletedAt ?? null})`,
  );
};

const A = "alice.convapi@test.dev";
const B = "bob.convapi@test.dev";

describe("chat title / fork / search / attachment refs", () => {
  let ctx: TestCtx;
  let wsA: string;
  let ac: string;
  let bc: string;
  let chatId: string;

  const before = async () => {
    if (ctx) return;
    ctx = await makeCtx();
    ac = await ctx.cookie(A);
    bc = await ctx.cookie(B);
    const alice = await ctx.userId(A);
    const bob = await ctx.userId(B);
    wsA = "ws-convapi";
    await seedWorkspace(ctx.db, wsA, alice);
    // Published model used by fork-transcript assistant messages.
    await ctx.db.execute(
      sql`INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at)
          VALUES ('model-m', 'm', 'm', 'M', 'test', true, true, ${Date.now()}, ${Date.now()})`,
    );
    await addMember(ctx.db, wsA, bob, "member");
    chatId = await createChat(ctx, wsA, ac);
  };

  test("PUT /title: conditional rename, no transcript, stale 409, auth gates", async () => {
    await before();
    // Seed a transcript at version 2.
    const put = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, {
      method: "PUT",
      cookie: ac,
      body: { version: 1, messages: [{ role: "user", content: "keep me" }] },
    });
    expect(put.status).toBe(200);

    const res = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}/title`, {
      method: "PUT",
      cookie: ac,
      body: { version: 2, title: "  Renamed  " },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; version: number };
    expect(body).toEqual({ id: chatId, version: 3 });

    // Transcript untouched, title trimmed.
    const snap = (await (
      await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac })
    ).json()) as { title: string; version: number; messages: unknown[] };
    expect(snap.title).toBe("Renamed");
    expect(snap.version).toBe(3);
    expect(snap.messages).toEqual([{ role: "user", content: "keep me" }]);

    // Stale version → 409, nothing changes.
    const stale = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}/title`, {
      method: "PUT",
      cookie: ac,
      body: { version: 2, title: "Stale" },
    });
    expect(stale.status).toBe(409);
    const snap2 = (await (
      await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac })
    ).json()) as { title: string; version: number };
    expect(snap2.title).toBe("Renamed");
    expect(snap2.version).toBe(3);

    // Validation + auth.
    for (const body of [{ version: 3 }, { version: 3, title: "" }, { title: "x" }]) {
      expect(
        (
          await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}/title`, {
            method: "PUT",
            cookie: ac,
            body,
          })
        ).status,
      ).toBe(400);
    }
    // Other member / wrong workspace / unauthed → 404/403/401, no rename.
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}/title`, {
          method: "PUT",
          cookie: bc,
          body: { version: 3, title: "Hijack" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}/title`, {
          method: "PUT",
          body: { version: 3, title: "Anon" },
        })
      ).status,
    ).toBe(401);
    const final = (await (
      await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac })
    ).json()) as { title: string; version: number };
    expect(final.title).toBe("Renamed");
    expect(final.version).toBe(3);
  });

  test("GET list ?q: filtered before cursor, LIKE wildcards escaped, validated", async () => {
    await before();
    const ids: Record<string, string> = {};
    for (const title of ["alpha plan", "beta plan", "50% off", "under_score", "gamma"]) {
      const id = await createChat(ctx, wsA, ac);
      ids[title] = id;
      await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${id}/title`, {
        method: "PUT",
        cookie: ac,
        body: { version: 1, title },
      });
    }
    const list = async (q: string, cursor?: string) => {
      const qs = new URLSearchParams({ q });
      if (cursor) qs.set("cursor", cursor);
      const res = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats?${qs}`, { cookie: ac });
      expect(res.status).toBe(200);
      return (await res.json()) as { data: { id: string; title: string }[]; nextCursor: string | null };
    };
    const titles = (r: { data: { title: string }[] }) => r.data.map((c) => c.title).sort();

    expect(titles(await list("plan"))).toEqual(["alpha plan", "beta plan"]);
    // % must match a literal percent, not any sequence.
    expect(titles(await list("50% off"))).toEqual(["50% off"]);
    expect(titles(await list("%"))).toEqual(["50% off"]);
    // _ must match a literal underscore.
    expect(titles(await list("under_score"))).toEqual(["under_score"]);
    expect(titles(await list("underxscore"))).toEqual([]);
    // Backslash is escaped too.
    expect(titles(await list("\\"))).toEqual([]);

    // Filter applies BEFORE the cursor: keyset over the filtered set only.
    const first = await list("plan");
    expect(first.data.length).toBe(2);
    // Cursor with the filter must never leak filtered-out rows.
    const cursor = `${Date.now() + 10_000}.${ids["gamma"]}`;
    const filtered = await list("plan", cursor);
    expect(filtered.data.every((c) => c.title.includes("plan"))).toBe(true);
    // Bounded query length.
    const res = await req(
      ctx.app,
      `/api/v1/workspaces/${wsA}/chats?q=${encodeURIComponent("x".repeat(121))}`,
      { cookie: ac },
    );
    expect(res.status).toBe(400);
  });

  test("PUT attachments: canonical DB metadata wins over forged client refs; dead refs rejected all-or-nothing", async () => {
    await before();
    const alice = await ctx.userId(A);
    const liveId = "att-live-0001";
    await seedAttachment(ctx.db, {
      id: liveId,
      userId: alice,
      wsId: wsA,
      name: "real-name.png",
      mime: "image/png",
      bytes: 4321,
    });

    // Forged metadata is replaced by the canonical chat_attachments row.
    const put = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, {
      method: "PUT",
      cookie: ac,
      body: {
        version: 3,
        messages: [
          {
            role: "user",
            content: "with file",
            attachments: [
              {
                id: liveId,
                name: "FORGED.png",
                kind: "text",
                bytes: 1,
                mime: "text/html",
                expires_at: 0,
              },
            ],
          },
        ],
      },
    });
    expect(put.status).toBe(200);
    const snap = (await (
      await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac })
    ).json()) as { messages: { attachments?: Record<string, unknown>[] }[] };
    expect(snap.messages[0]?.attachments?.[0]).toMatchObject({
      id: liveId,
      name: "real-name.png",
      kind: "image",
      mime: "image/png",
      bytes: 4321,
    });

    // Unknown / foreign / expired / tombstoned new refs → 400 and NO write.
    const expiredId = "att-expired-1";
    await seedAttachment(ctx.db, {
      id: expiredId,
      userId: alice,
      wsId: wsA,
      expiresAt: Date.now() - 1000,
    });
    const deadId = "att-deleted-1";
    await seedAttachment(ctx.db, {
      id: deadId,
      userId: alice,
      wsId: wsA,
      deletedAt: Date.now(),
    });
    await seedAttachment(ctx.db, { id: "att-bob-1", userId: await ctx.userId(B), wsId: wsA });
    const badBodies: unknown[] = [
      { version: 4, messages: [{ role: "user", content: "x", attachments: [{ id: "att-nope" }] }] },
      { version: 4, messages: [{ role: "user", content: "x", attachments: [{ id: expiredId }] }] },
      { version: 4, messages: [{ role: "user", content: "x", attachments: [{ id: deadId }] }] },
      { version: 4, messages: [{ role: "user", content: "x", attachments: [{ id: "att-bob-1" }] }] },
      // All-or-nothing: one good ref + one dead ref rejects the whole save.
      {
        version: 4,
        messages: [
          { role: "user", content: "x", attachments: [{ id: liveId }] },
          { role: "user", content: "y", attachments: [{ id: "att-nope" }] },
        ],
      },
      // Role restrictions.
      { version: 4, messages: [{ role: "assistant", content: "x", attachments: [{ id: liveId }] }] },
      { version: 4, messages: [{ role: "user", content: "x", request_id: "req_x" }] },
    ];
    for (const body of badBodies) {
      const r = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, {
        method: "PUT",
        cookie: ac,
        body: body as Record<string, unknown>,
      });
      expect(r.status).toBe(400);
    }
    const after = (await (
      await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac })
    ).json()) as { version: number; messages: unknown[] };
    expect(after.version).toBe(4); // failed PUTs never bumped the version

    // Grandfathering: the stored ref survives expiry + tombstone on re-save.
    await ctx.db.execute(
      sql`UPDATE chat_attachments SET expires_at = ${Date.now() - 5000}, deleted_at = ${Date.now()} WHERE id = ${liveId}`,
    );
    const resave = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, {
      method: "PUT",
      cookie: ac,
      body: {
        version: 4,
        messages: [
          { role: "user", content: "with file", attachments: [{ id: liveId }] },
          { role: "assistant", content: "ok", request_id: "req_grandfather" },
        ],
      },
    });
    expect(resave.status).toBe(200);
    const snap2 = (await (
      await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac })
    ).json()) as { messages: { attachments?: { id: string }[] }[] };
    expect(snap2.messages[0]?.attachments?.[0]?.id).toBe(liveId);
  });

  test("POST /fork: 201 full snapshot, prefix through user turn, source unchanged, stale 409", async () => {
    await before();
    // Build a source transcript at version 2: user, assistant(model+request_id), user, assistant.
    const put = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, {
      method: "PUT",
      cookie: ac,
      body: {
        version: 5,
        messages: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1", model: "m", request_id: "req_a1" },
          { role: "user", content: "q2 original" },
          { role: "assistant", content: "a2" },
        ],
      },
    });
    expect(put.status).toBe(200);

    const forkRes = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}/fork`, {
      method: "POST",
      cookie: ac,
      body: { version: 6, message_index: 2, content: "q2 edited" },
    });
    expect(forkRes.status).toBe(201);
    const fork = (await forkRes.json()) as {
      id: string;
      version: number;
      title: string;
      messages: { role: string; content: string; model?: string; request_id?: string }[];
    };
    expect(fork.id).not.toBe(chatId);
    expect(fork.version).toBe(1);
    expect(fork.messages).toHaveLength(3);
    expect(fork.messages.map((m) => m.content)).toEqual(["q1", "a1", "q2 edited"]);
    expect(fork.messages[1]).toMatchObject({ model: "m", request_id: "req_a1" });

    // Source completely unchanged.
    const src = (await (
      await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac })
    ).json()) as { version: number; messages: unknown[] };
    expect(src.version).toBe(6);
    expect(src.messages).toHaveLength(4);

    // Fork without content keeps the original user turn verbatim.
    const fork2Res = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}/fork`, {
      method: "POST",
      cookie: ac,
      body: { version: 6, message_index: 0 },
    });
    expect(fork2Res.status).toBe(201);
    const fork2 = (await fork2Res.json()) as { messages: { role: string; content: string }[] };
    expect(fork2.messages.map((m) => m.content)).toEqual(["q1"]);

    // Stale version → 409, no fork row created.
    const countBefore = (await ctx.db.execute(
      sql`SELECT count(*)::int AS c FROM chat_conversations`,
    )) as unknown as { c: number }[];
    const stale = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}/fork`, {
      method: "POST",
      cookie: ac,
      body: { version: 1, message_index: 0 },
    });
    expect(stale.status).toBe(409);
    const countAfter = (await ctx.db.execute(
      sql`SELECT count(*)::int AS c FROM chat_conversations`,
    )) as unknown as { c: number }[];
    expect(countAfter[0]?.c).toBe(countBefore[0]?.c);

    // Validation: assistant index, out of range, bad shapes.
    for (const body of [
      { version: 6, message_index: 1 },
      { version: 6, message_index: 99 },
      { version: 6, message_index: -1 },
      { message_index: 0 },
      { version: 6, message_index: 0, content: 42 },
    ]) {
      const r = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}/fork`, {
        method: "POST",
        cookie: ac,
        body,
      });
      expect(r.status).toBe(400);
    }
    // Other member / unauthed.
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}/fork`, {
          method: "POST",
          cookie: bc,
          body: { version: 6, message_index: 0 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}/fork`, {
          method: "POST",
          body: { version: 6, message_index: 0 },
        })
      ).status,
    ).toBe(401);
  });

  test("fork grandfathers expired attachment refs from the source prefix", async () => {
    await before();
    const alice = await ctx.userId(A);
    const attId = "att-fork-1";
    await seedAttachment(ctx.db, { id: attId, userId: alice, wsId: wsA });
    const put = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, {
      method: "PUT",
      cookie: ac,
      body: {
        version: ((await (
          await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac })
        ).json()) as { version: number }).version,
        messages: [{ role: "user", content: "has file", attachments: [{ id: attId }] }],
      },
    });
    expect(put.status).toBe(200);
    // Expire it after it entered history.
    await ctx.db.execute(
      sql`UPDATE chat_attachments SET expires_at = ${Date.now() - 1000} WHERE id = ${attId}`,
    );
    const snap = (await (
      await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac })
    ).json()) as { version: number };
    const forkRes = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}/fork`, {
      method: "POST",
      cookie: ac,
      body: { version: snap.version, message_index: 0 },
    });
    expect(forkRes.status).toBe(201);
    const fork = (await forkRes.json()) as {
      messages: { attachments?: { id: string; expires_at: number }[] }[];
    };
    expect(fork.messages[0]?.attachments?.[0]?.id).toBe(attId);
  });
});
