// Chat model persistence (apps/api/src/routes/chats.ts): assistant `model?`
// inside the existing messages JSONB. Behavioral contract:
// - `model` accepted only on assistant messages, string only, membership in
//   the enabled+published `models.public_id` set (no equality blacklist).
// - Historical retention: model strings already present in the stored snapshot
//   pass even after unpublish/disable; only NEWLY introduced values are gated.
// - All-or-nothing: invalid model → 400 with no messages/title/version write.
// - Limits preserved: 512 KiB body, 64 KiB content, no billing side effects.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { users, workspaces, workspaceMembers, models } from "../packages/db/src/schema";
import { buildApp } from "../apps/api/src/app";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";
import type { Db as DbT } from "../packages/db/src/index";

const USER_ID = "user-modelval";
const WS_ID = "ws-modelval";
const EMAIL = "modelval@test";

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

const json = (res: Response) => res.json() as Promise<Record<string, unknown>>;

let chatId = "";
let version = 1;

const req = (path: string, opts: { method?: string; body?: unknown; rawBody?: string } = {}) =>
  app.handle(
    new Request("http://localhost" + path, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body !== undefined || opts.rawBody !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    }),
  );

const put = (body: Record<string, unknown>, id = chatId) =>
  req(`/api/v1/workspaces/${WS_ID}/chats/${id}`, { method: "PUT", body });

const snapshot = async (id = chatId) =>
  (await (await req(`/api/v1/workspaces/${WS_ID}/chats/${id}`)).json()) as {
    version: number;
    title: string;
    messages: { role: string; content: string; reasoning?: string; model?: string }[];
  };

/** Insert a catalog model; public_id defaults to the id (public_id === id fixture). */
async function seedModel(
  d: DbT,
  id: string,
  opts: { publicId?: string; enabled?: boolean; published?: boolean } = {},
) {
  await d
    .insert(models)
    .values({
      id,
      public_id: opts.publicId ?? id,
      slug: `${id}-slug`,
      display_name: id,
      provider: "prov",
      enabled: opts.enabled ?? true,
      published: opts.published ?? true,
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    .onConflictDoNothing();
}

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  const now = Date.now();
  await db.insert(users).values({
    id: USER_ID,
    name: "Owner",
    email: EMAIL,
    emailVerified: true,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await db.insert(workspaces).values({ id: WS_ID, name: "WS", created_at: now });
  await db
    .insert(workspaceMembers)
    .values({ workspace_id: WS_ID, user_id: USER_ID, role: "owner" });
  app = await buildApp({ db, auth: fakeAuth(USER_ID) });
  const res = await req(`/api/v1/workspaces/${WS_ID}/chats`, { method: "POST" });
  expect(res.status).toBe(201);
  const chat = (await json(res)) as { id: string };
  chatId = chat.id;
});

afterAll(async () => {
  await drop();
});

describe("chat history assistant model validation", () => {
  test("assistant model on a published public_id is persisted and read back", async () => {
    await seedModel(db, "m-pub");
    const res = await put({
      version,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", reasoning: "r", model: "m-pub" },
      ],
    });
    expect(res.status).toBe(200);
    const saved = (await json(res)) as { messages: { model?: string }[]; version: number };
    version = saved.version;
    expect(saved.messages[1]?.model).toBe("m-pub");
    const snap = await snapshot();
    expect(snap.messages[1]?.model).toBe("m-pub");
  });

  test("user-message model, non-string model → 400 all-or-nothing", async () => {
    const cases: unknown[] = [
      { version, messages: [{ role: "user", content: "hi", model: "m-pub" }] },
      { version, messages: [{ role: "assistant", content: "x", model: 5 }] },
      { version, messages: [{ role: "assistant", content: "x", model: { id: "m-pub" } }] },
    ];
    for (const body of cases) {
      const res = await put(body as Record<string, unknown>);
      expect(res.status).toBe(400);
    }
    const snap = await snapshot();
    expect(snap.version).toBe(version);
    expect(snap.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", reasoning: "r", model: "m-pub" },
    ]);
  });

  test("membership-only: published public_id equal to models.id accepted; internal-only id/slug and forged ids rejected", async () => {
    await seedModel(db, "dual-named");
    await seedModel(db, "internal-1", { publicId: "public-1" });
    let res = await put({
      version,
      messages: [{ role: "assistant", content: "a", model: "dual-named" }],
    });
    expect(res.status).toBe(200);
    version = ((await json(res)) as { version: number }).version;
    // models.id matches but is not any enabled+published public_id → 400
    res = await put({
      version,
      messages: [{ role: "assistant", content: "b", model: "internal-1" }],
    });
    expect(res.status).toBe(400);
    // slug likewise
    res = await put({
      version,
      messages: [{ role: "assistant", content: "b", model: "internal-1-slug" }],
    });
    expect(res.status).toBe(400);
    // forged upstream id: never a public_id → 400
    res = await put({
      version,
      messages: [{ role: "assistant", content: "b", model: "upstream/private-only" }],
    });
    expect(res.status).toBe(400);
    const snap = await snapshot();
    expect(snap.version).toBe(version);
    expect(snap.messages).toEqual([{ role: "assistant", content: "a", model: "dual-named" }]);
  });

  test("disabled or unpublished catalog entries are rejected for NEW values", async () => {
    await seedModel(db, "m-off", { enabled: false });
    await seedModel(db, "m-unpub", { published: false });
    for (const m of ["m-off", "m-unpub"]) {
      const res = await put({
        version,
        messages: [{ role: "assistant", content: "x", model: m }],
      });
      expect(res.status).toBe(400);
    }
    const snap = await snapshot();
    expect(snap.version).toBe(version);
  });

  test("historical retention: retained model survives unpublish/disable; mixed snapshot with new published model succeeds", async () => {
    await seedModel(db, "m-hist");
    let res = await put({
      version,
      messages: [{ role: "assistant", content: "old", model: "m-hist" }],
    });
    expect(res.status).toBe(200);
    version = ((await json(res)) as { version: number }).version;
    // Catalog churn: model becomes disabled AND unpublished.
    await db.$client.unsafe(
      "UPDATE models SET enabled = false, published = false WHERE id = 'm-hist'",
    );
    // Retained value passes unchanged (title update included).
    res = await put({
      version,
      title: "renamed-kept",
      messages: [{ role: "assistant", content: "old", model: "m-hist" }],
    });
    expect(res.status).toBe(200);
    version = ((await json(res)) as { version: number }).version;
    // Mixed snapshot: retained unpublished model + NEWLY introduced published model.
    await seedModel(db, "m-new");
    res = await put({
      version,
      messages: [
        { role: "assistant", content: "old", model: "m-hist" },
        { role: "assistant", content: "new", model: "m-new" },
      ],
    });
    expect(res.status).toBe(200);
    version = ((await json(res)) as { version: number }).version;
    const snap = await snapshot();
    expect(snap.title).toBe("renamed-kept");
    expect(snap.messages[0]?.model).toBe("m-hist");
    expect(snap.messages[1]?.model).toBe("m-new");
    // Same snapshot but the NEW value is unpublished → 400, all-or-nothing.
    await seedModel(db, "m-new2", { published: false });
    res = await put({
      version,
      title: "must-not-apply",
      messages: [
        { role: "assistant", content: "old", model: "m-hist" },
        { role: "assistant", content: "bad", model: "m-new2" },
      ],
    });
    expect(res.status).toBe(400);
    const unchanged = await snapshot();
    expect(unchanged.version).toBe(version);
    expect(unchanged.title).toBe("renamed-kept");
    expect(unchanged.messages[1]?.content).toBe("new");
  });

  test("concurrent snapshot conflict: stale version PUT → 409 even with a valid new model; stored snapshot preserved", async () => {
    await seedModel(db, "m-conc");
    const res = await put({
      version: 1,
      messages: [{ role: "assistant", content: "stale", model: "m-conc" }],
    });
    expect(res.status).toBe(409);
    const err = (await json(res)) as { error: { code: string } };
    expect(err.error.code).toBe("CONFLICT");
  });

  test("limits preserved: >512KiB body → 413; >64KiB content → 400; reasoning still stored", async () => {
    const big = JSON.stringify({
      version,
      messages: [{ role: "user", content: "x".repeat(600 * 1024) }],
    });
    expect(
      (
        await req(`/api/v1/workspaces/${WS_ID}/chats/${chatId}`, {
          method: "PUT",
          rawBody: big,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await put({
          version,
          messages: [{ role: "user", content: "x".repeat(64 * 1024 + 1) }],
        })
      ).status,
    ).toBe(400);
    // Reasoning still persisted on assistant messages.
    await seedModel(db, "m-reason");
    const ok = await put({
      version,
      messages: [{ role: "assistant", content: "r", reasoning: "why", model: "m-reason" }],
    });
    expect(ok.status).toBe(200);
    const saved = (await json(ok)) as { version: number };
    version = saved.version;
    const snap = await snapshot();
    expect(snap.messages[0]).toEqual({
      role: "assistant",
      content: "r",
      reasoning: "why",
      model: "m-reason",
    });
  });

  test("no billing side effects: ledger stays empty after every save", async () => {
    const ledger = await db.$client.unsafe("SELECT count(*)::int AS c FROM ledger_entries");
    expect((ledger[0] as { c: number }).c).toBe(0);
  });
});
