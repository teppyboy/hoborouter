// Chat history storage routes (apps/api/src/routes/chats.ts) — standalone
// route contract tests (route not yet wired into app.ts; tested via its own
// Elysia instance with only the Better Auth handler mounted for sign-up).
// Covers: private ownership, membership gates, metadata-only list, keyset
// pagination, optimistic-version conflict, input validation, 512 KiB bounded
// body, soft archive, and the no-billing invariant (no wallet/ledger writes).
import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { afterAll, describe, expect, test } from "bun:test";
import { createAuth } from "../src/auth";
import { chatsRoutes } from "../src/routes/chats";
import { eq, sql } from "drizzle-orm";
import { workspaceMembers } from "@hoborouter/db";

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
  // Standalone: only the auth handler (for sign-up) + chats routes.
  const app = new Elysia({ name: "chats-test" })
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
    // 422 = already signed up in a prior test → sign in instead.
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

// Structural type: avoids Elysia generic-identity mismatch across instances.
type HandleLike = { handle: (req: Request) => Promise<Response> };
const req = (
  app: HandleLike,
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown; rawBody?: string } = {},
) => {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined || opts.rawBody !== undefined)
    headers["content-type"] = "application/json";
  return app.handle(
    new Request("http://localhost" + path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    }),
  );
};

async function seedWorkspace(db: Db, wsId: string, ownerId: string) {
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at) VALUES (${wsId}, ${wsId}, 'active', ${Date.now()})`,
  );
  await db.execute(
    sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${ownerId}, 'owner')`,
  );
}

async function addMember(db: Db, wsId: string, userId: string, role: string) {
  await db.execute(
    sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${userId}, ${role})`,
  );
}

async function makeInstanceAdmin(db: Db, userId: string) {
  await db.execute(
    sql`INSERT INTO instance_admins (user_id, created_at) VALUES (${userId}, ${Date.now()})`,
  );
}

describe("chats routes (standalone)", () => {
  let ctx: TestCtx;
  let alice: string;
  let wsA: string;
  let chatId: string;

  const A = "alice.chats@test.dev";
  const B = "bob.chats@test.dev";
  const ADMIN = "admin.chats@test.dev";
  const NONMEMBER = "carol.chats@test.dev";
  const IADMIN = "eve.chats@test.dev";

  const before = async () => {
    if (ctx) return;
    ctx = await makeCtx();
    // Sign up (or sign in) first — user ids exist only after that.
    await ctx.cookie(A);
    await ctx.cookie(B);
    await ctx.cookie(ADMIN);
    await ctx.cookie(NONMEMBER);
    await ctx.cookie(IADMIN);
    alice = await ctx.userId(A);
    const bob = await ctx.userId(B);
    const admin = await ctx.userId(ADMIN);
    const iadmin = await ctx.userId(IADMIN);
    wsA = "ws-chats-a";
    await seedWorkspace(ctx.db, wsA, alice);
    await addMember(ctx.db, wsA, bob, "member");
    await addMember(ctx.db, wsA, admin, "admin");
    await makeInstanceAdmin(ctx.db, iadmin);
  };

  test("POST creates conversation: 201, 'New chat', no billing side effects", async () => {
    await before();
    const res = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats`, {
      method: "POST",
      cookie: await ctx.cookie(A),
    });
    expect(res.status).toBe(201);
    const chat = (await res.json()) as Record<string, unknown>;
    expect(chat.title).toBe("New chat");
    expect(chat.version).toBe(1);
    expect(chat.messages).toEqual([]);
    expect(chat.model).toBeNull();
    chatId = chat.id as string;

    // No wallet change, no ledger entry, no API key created.
    const wallet = (await ctx.db.execute(
      sql`SELECT balance FROM wallets WHERE workspace_id = ${wsA}`,
    )) as unknown as { balance: number }[];
    if (wallet[0]) expect(Number(wallet[0].balance)).toBe(0);
    const ledger = (await ctx.db.execute(
      sql`SELECT count(*)::int AS c FROM ledger_entries`,
    )) as unknown as { c: number }[];
    expect(ledger[0]?.c ?? -1).toBe(0);
    const keys = (await ctx.db.execute(
      sql`SELECT count(*)::int AS c FROM api_keys`,
    )) as unknown as { c: number }[];
    expect(keys[0]?.c ?? -1).toBe(0);
  });

  test("GET snapshot returns full conversation incl. messages", async () => {
    await before();
    const ac = await ctx.cookie(A);
    const put = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, {
      method: "PUT",
      cookie: ac,
      body: {
        version: 1,
        messages: [{ role: "user", content: "hello" }],
        reasoning_check: undefined,
      },
    });
    expect(put.status).toBe(200);
    const res = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac });
    expect(res.status).toBe(200);
    const chat = (await res.json()) as { messages: unknown[]; version: number };
    expect(chat.version).toBe(2);
    expect(chat.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  test("list metadata has no messages; active only; deterministic order", async () => {
    await before();
    const res = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats`, {
      cookie: await ctx.cookie(A),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<string, unknown>[];
      nextCursor: string | null;
    };
    expect(body.data.length).toBe(1);
    expect(Object.keys(body.data[0] ?? {}).sort()).toEqual([
      "created_at",
      "id",
      "model",
      "title",
      "updated_at",
      "version",
    ]);
  });

  test("private ownership: member B / workspace admin / nonmember / instance admin cannot read A's chat", async () => {
    await before();
    const ac = await ctx.cookie(A);
    const bc = await ctx.cookie(B);
    const adminC = await ctx.cookie(ADMIN);
    const nmC = await ctx.cookie(NONMEMBER);
    const iaC = await ctx.cookie(IADMIN);
    // member B → 404 (no existence leak)
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: bc })).status,
    ).toBe(404);
    // workspace admin → 404 (admins get no visibility into other users' chats)
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: adminC })).status,
    ).toBe(404);
    // workspace non-member → 403 (membership gate)
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: nmC })).status,
    ).toBe(403);
    // instance admin without membership → 403 (no exception)
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: iaC })).status,
    ).toBe(403);
    // owner still reads fine
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac })).status,
    ).toBe(200);
    // list is owner-scoped too: B's list never contains A's chat
    const list = (await (
      await req(ctx.app, `/api/v1/workspaces/${wsA}/chats`, { cookie: bc })
    ).json()) as { data: { id: string }[] };
    expect(list.data.some((c) => c.id === chatId)).toBe(false);
    // unauthed → 401
    expect((await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`)).status).toBe(401);
  });

  test("workspace filters: chat invisible via other workspace (404), list empty", async () => {
    await before();
    const ac = await ctx.cookie(A);
    await ctx.db.execute(
      sql`INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-chats-b', 'b', 'active', ${Date.now()})`,
    );
    await ctx.db.execute(
      sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-chats-b', ${alice}, 'owner')`,
    );
    expect(
      (await req(ctx.app, `/api/v1/workspaces/ws-chats-b/chats/${chatId}`, { cookie: ac })).status,
    ).toBe(404);
    const list = (await (
      await req(ctx.app, `/api/v1/workspaces/ws-chats-b/chats`, { cookie: ac })
    ).json()) as { data: unknown[] };
    expect(list.data).toEqual([]);
  });

  test("missing chat → 404", async () => {
    await before();
    const res = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/does-not-exist`, {
      cookie: await ctx.cookie(A),
    });
    expect(res.status).toBe(404);
  });

  test("PUT validation: bad role, empty/long title, bad version, >500 messages, >64KiB content → 400", async () => {
    await before();
    const ac = await ctx.cookie(A);
    const base = { version: 2, messages: [] as unknown[] };
    const cases: unknown[] = [
      { ...base, messages: [{ role: "system", content: "x" }] },
      { ...base, messages: [{ role: "tool", content: "x" }] },
      { ...base, messages: [{ role: "user", content: 42 }] },
      { ...base, messages: [{ role: "user", content: "ok", reasoning: 5 }] },
      { ...base, title: "" },
      { ...base, title: "x".repeat(121) },
      { ...base, version: 0 },
      { ...base, version: "2" },
      { messages: [] },
      { ...base, messages: "nope" },
      { ...base, messages: Array.from({ length: 501 }, () => ({ role: "user", content: "m" })) },
      { ...base, messages: [{ role: "user", content: "x".repeat(64 * 1024 + 1) }] },
    ];
    for (const body of cases) {
      const res = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, {
        method: "PUT",
        cookie: ac,
        body,
      });
      expect(res.status).toBe(400);
    }
  });

  test("PUT >512KiB body rejected with 413 before buffering", async () => {
    await before();
    const ac = await ctx.cookie(A);
    // ~600 KiB of content in a single message.
    const big = JSON.stringify({
      version: 2,
      messages: [{ role: "user", content: "x".repeat(600 * 1024) }],
    });
    const res = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, {
      method: "PUT",
      cookie: ac,
      rawBody: big,
    });
    expect(res.status).toBe(413);
    // Snapshot untouched (still version 2 from earlier test).
    const chat = (await (
      await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac })
    ).json()) as { version: number };
    expect(chat.version).toBe(2);
  });

  test("version conflict: stale PUT → 409 CONFLICT, stored snapshot preserved", async () => {
    await before();
    const ac = await ctx.cookie(A);
    // Current version is 2. A stale writer using version 1 must get 409...
    const stale = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, {
      method: "PUT",
      cookie: ac,
      body: { version: 1, messages: [{ role: "user", content: "stale overwrite" }] },
    });
    expect(stale.status).toBe(409);
    const err = (await stale.json()) as { error: { code: string } };
    expect(err.error.code).toBe("CONFLICT");
    // ...and the stored snapshot must be unchanged.
    const chat = (await (
      await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac })
    ).json()) as { version: number; messages: { content: string }[] };
    expect(chat.version).toBe(2);
    expect(chat.messages[0]?.content).toBe("hello");
  });

  test("PUT success bumps version and updates snapshot; no wallet/ledger writes", async () => {
    await before();
    const ac = await ctx.cookie(A);
    const res = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, {
      method: "PUT",
      cookie: ac,
      body: {
        version: 2,
        title: "Renamed",
        model: "gpt-x",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hey", reasoning: "because" },
        ],
      },
    });
    expect(res.status).toBe(200);
    const chat = (await res.json()) as {
      version: number;
      title: string;
      model: string | null;
      messages: { role: string; content: string; reasoning?: string }[];
    };
    expect(chat.version).toBe(3);
    expect(chat.title).toBe("Renamed");
    expect(chat.model).toBe("gpt-x");
    expect(chat.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey", reasoning: "because" },
    ]);
    const ledger = (await ctx.db.execute(
      sql`SELECT count(*)::int AS c FROM ledger_entries`,
    )) as unknown as { c: number }[];
    expect(ledger[0]?.c ?? -1).toBe(0);
  });

  test("pagination: 500 cap not hit on list of 60; 50 max, deterministic keyset cursor", async () => {
    await before();
    const ac = await ctx.cookie(A);
    // Create 59 more chats (total 60 for alice in wsA).
    for (let i = 0; i < 59; i++) {
      const r = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats`, {
        method: "POST",
        cookie: ac,
      });
      expect(r.status).toBe(201);
    }
    // Force deterministic distinct updated_at values: oldest first inserted.
    await ctx.db.execute(
      sql`UPDATE chat_conversations c SET updated_at = 1000 + o.rn
       FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn FROM chat_conversations
             WHERE workspace_id = ${wsA} AND user_id = ${alice}) o
       WHERE c.id = o.id`,
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const url = `/api/v1/workspaces/${wsA}/chats${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await req(ctx.app, url, { cookie: ac });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { id: string; updated_at: number }[];
        nextCursor: string | null;
      };
      expect(body.data.length).toBeLessThanOrEqual(50);
      // Deterministic: descending (updated_at, id) within and across pages.
      for (let i = 1; i < body.data.length; i++) {
        const prev = body.data[i - 1];
        const cur = body.data[i];
        if (!prev || !cur) continue;
        expect(
          prev.updated_at > cur.updated_at ||
            (prev.updated_at === cur.updated_at && prev.id > cur.id),
        ).toBe(true);
      }
      for (const c of body.data) seen.push(c.id);
      pages++;
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(2);
    expect(seen.length).toBe(60);
    expect(new Set(seen).size).toBe(60);

    // Invalid cursor → 400.
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${wsA}/chats?cursor=garbage`, { cookie: ac })).status,
    ).toBe(400);
  });

  test("soft archive: archived disappears from list, history retained, idempotent PATCH, no DELETE", async () => {
    await before();
    const ac = await ctx.cookie(A);
    // Archive the oldest listed conversation... archive by creating a fresh one.
    const created = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats`, {
      method: "POST",
      cookie: ac,
    });
    const chat = (await created.json()) as { id: string };
    // Put a message in it so "history retained" is meaningful.
    await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chat.id}`, {
      method: "PUT",
      cookie: ac,
      body: { version: 1, messages: [{ role: "user", content: "keep me" }] },
    });
    const patch = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chat.id}`, {
      method: "PATCH",
      cookie: ac,
      body: { archived: true },
    });
    expect(patch.status).toBe(200);
    const archived = (await patch.json()) as { id: string; archived_at: number | null };
    expect(archived.id).toBe(chat.id);
    expect(typeof archived.archived_at).toBe("number");
    // Idempotent re-archive → 200, same timestamp.
    const again = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chat.id}`, {
      method: "PATCH",
      cookie: ac,
      body: { archived: true },
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { archived_at: number }).archived_at).toBe(
      archived.archived_at ?? -1,
    );
    // Disappears from list.
    const list = (await (
      await req(ctx.app, `/api/v1/workspaces/${wsA}/chats`, { cookie: ac })
    ).json()) as { data: { id: string }[] };
    expect(list.data.some((c) => c.id === chat.id)).toBe(false);
    // History retained: full snapshot still readable.
    const snap = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chat.id}`, { cookie: ac });
    expect(snap.status).toBe(200);
    const full = (await snap.json()) as { messages: { content: string }[] };
    expect(full.messages as unknown).toEqual([{ role: "user", content: "keep me" }]);
    // PUT on archived → 409, data intact.
    const put = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chat.id}`, {
      method: "PUT",
      cookie: ac,
      body: { version: 2, messages: [] },
    });
    expect(put.status).toBe(409);
  });

  test("lost membership denies access (403) even for the owner", async () => {
    await before();
    const ac = await ctx.cookie(A);
    const bobId = await ctx.userId(B);
    const created = await req(ctx.app, `/api/v1/workspaces/${wsA}/chats`, {
      method: "POST",
      cookie: await ctx.cookie(B),
    });
    const bobChat = (await created.json()) as { id: string };
    // B can read their own chat...
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${bobChat.id}`, {
          cookie: await ctx.cookie(B),
        })
      ).status,
    ).toBe(200);
    // ...until membership is lost.
    await ctx.db.delete(workspaceMembers).where(eq(workspaceMembers.user_id, bobId));
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${bobChat.id}`, {
          cookie: await ctx.cookie(B),
        })
      ).status,
    ).toBe(403);
    // A (still a member) unaffected.
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${wsA}/chats/${chatId}`, { cookie: ac })).status,
    ).toBe(200);
  });
});
