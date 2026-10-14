// Per-request chat billing receipts (apps/api/src/routes/chat-receipts.ts).
// Standalone route contract tests on a real migrated test DB. Covers: pending
// (no usage → charged_vnd null), settled (actual VND), failed full-hold
// settlement (actual VND, never forced to zero), member visibility (own-key
// requests only, no existence leak), admin sees the workspace, foreign
// workspace 404, unknown request 404, and the DTO exposing no raw/private
// billing fields.
import { Elysia } from "elysia";
import { createTestDb } from "@hoborouter/db";
import { afterAll, describe, expect, test } from "bun:test";
import { createAuth } from "../src/auth";
import { chatReceiptsRoutes } from "../src/routes/chat-receipts";
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
  const app = new Elysia({ name: "chat-receipts-test" })
    .get("/api/auth/*", authHandler)
    .all("/api/auth/*", authHandler)
    .use(chatReceiptsRoutes(db, auth));

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
const req = (app: HandleLike, path: string, cookie?: string) =>
  app.handle(
    new Request("http://localhost" + path, {
      headers: cookie ? { cookie } : {},
    }),
  );

const ALICE = "alice.receipts@test.dev"; // ws owner, key owner
const BOB = "bob.receipts@test.dev"; // member, own key
const CAROL = "carol.receipts@test.dev"; // admin, no key
const DAVE = "dave.receipts@test.dev"; // member, no key

describe("chat receipts route", () => {
  let ctx: TestCtx;
  let ws: string;
  let ac: string;
  let bc: string;
  let cc: string;
  let dc: string;

  const seedRequest = async (
    id: string,
    apiKeyId: string | null,
    status: string,
    usage:
      | undefined
      | {
          charged?: number | null;
          failure?: string | null;
          status?: string;
          model?: string;
        },
  ) => {
    await ctx.db.execute(
      sql`INSERT INTO requests (id, workspace_id, api_key_id, model_id, endpoint, mode, status, dispatch_state, created_at)
          VALUES (${id}, ${ws}, ${apiKeyId}, 'model-r', '/v1/chat/completions', 'stream', ${status},
                  ${usage ? "terminal" : "dispatching"}, ${Date.now()})`,
    );
    if (usage) {
      await ctx.db.execute(
        sql`INSERT INTO usage_logs (id, idempotency_key, request_id, api_key_id, workspace_id, provider,
                public_model, upstream_model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
                status, failure, charged_vnd, created_at)
            VALUES (${id + "-usage"}, ${id + "-idem"}, ${id}, ${apiKeyId}, ${ws}, 'test',
                ${usage.model ?? "public-m"}, 'upstream-m', 10, 20, 0, 0,
                ${usage.status ?? "ok"}, ${usage.failure ?? null}, ${usage.charged ?? null}, ${Date.now()})`,
      );
    }
  };

  const before = async () => {
    if (ctx) return;
    ctx = await makeCtx();
    ac = await ctx.cookie(ALICE);
    bc = await ctx.cookie(BOB);
    cc = await ctx.cookie(CAROL);
    dc = await ctx.cookie(DAVE);
    const alice = await ctx.userId(ALICE);
    const bob = await ctx.userId(BOB);
    const carol = await ctx.userId(CAROL);
    const dave = await ctx.userId(DAVE);
    ws = "ws-receipts";
    await ctx.db.execute(
      sql`INSERT INTO workspaces (id, name, status, created_at) VALUES (${ws}, ${ws}, 'active', ${Date.now()})`,
    );
    for (const [u, role] of [
      [alice, "owner"],
      [bob, "member"],
      [carol, "admin"],
      [dave, "member"],
    ] as const) {
      await ctx.db.execute(
        sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${u}, ${role})`,
      );
    }
    // requests_model_source check needs a model row.
    await ctx.db.execute(
      sql`INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at)
          VALUES ('model-r', 'public-m', 'public-m', 'M', 'test', true, true, ${Date.now()}, ${Date.now()})`,
    );
    // Keys: one per user (chat_member keys name their owner).
    for (const [kid, owner] of [
      ["key-alice", alice],
      ["key-bob", bob],
    ] as const) {
      await ctx.db.execute(
        sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, purpose, owner_user_id, created_at)
            VALUES (${kid}, ${ws}, ${kid + "-hash"}, 'sk-hbr-x', ${kid}, 'chat_member', ${owner}, ${Date.now()})`,
      );
    }
    await seedRequest("req-pending", "key-alice", "pending", undefined);
    await seedRequest("req-settled", "key-alice", "ok", { charged: 1234 });
    await seedRequest("req-failed", "key-alice", "upstream_error", {
      charged: 5000, // full-hold settlement on failure
      failure: "upstream broke",
      status: "failed",
    });
    await seedRequest("req-bob", "key-bob", "ok", { charged: 999 });
    // Foreign workspace where alice is also a member.
    await ctx.db.execute(
      sql`INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-other', 'other', 'active', ${Date.now()})`,
    );
    await ctx.db.execute(
      sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-other', ${alice}, 'owner')`,
    );
  };

  test("pending: no usage row → status pending, charged_vnd null", async () => {
    await before();
    const res = await req(ctx.app, `/api/v1/workspaces/${ws}/chat-receipts/req-pending`, ac);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("pending");
    expect(body.charged_vnd).toBeNull();
    expect(body.public_model).toBeNull();
    expect(body.request_id).toBe("req-pending");
  });

  test("settled: actual charged_vnd; failed: full-hold actual, never zeroed", async () => {
    await before();
    const settled = (await (
      await req(ctx.app, `/api/v1/workspaces/${ws}/chat-receipts/req-settled`, ac)
    ).json()) as Record<string, unknown>;
    expect(settled.status).toBe("settled");
    expect(settled.charged_vnd).toBe(1234);
    expect(settled.public_model).toBe("public-m");

    const failed = (await (
      await req(ctx.app, `/api/v1/workspaces/${ws}/chat-receipts/req-failed`, ac)
    ).json()) as Record<string, unknown>;
    expect(failed.status).toBe("failed");
    expect(failed.charged_vnd).toBe(5000);
  });

  test("DTO exposes no raw payload / private upstream / cost internals", async () => {
    await before();
    const res = await req(ctx.app, `/api/v1/workspaces/${ws}/chat-receipts/req-settled`, ac);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "charged_vnd",
      "created_at",
      "public_model",
      "request_id",
      "status",
    ]);
  });

  test("member visibility: only own-key requests; other members get 404 (no existence leak)", async () => {
    await before();
    // Alice (owner role) sees her own key's receipts.
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${ws}/chat-receipts/req-settled`, ac)).status,
    ).toBe(200);
    // Dave (plain member, no key) sees nothing — even existence is hidden.
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${ws}/chat-receipts/req-settled`, dc)).status,
    ).toBe(404);
    // Bob's own receipt is visible to Bob.
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${ws}/chat-receipts/req-bob`, bc)).status,
    ).toBe(200);
    // Bob cannot see Alice's receipts.
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${ws}/chat-receipts/req-settled`, bc)).status,
    ).toBe(404);
    // Unknown request id → 404.
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${ws}/chat-receipts/req-nope`, ac)).status,
    ).toBe(404);
    // Request known in ws but queried via alice's other workspace → 404.
    expect(
      (await req(ctx.app, `/api/v1/workspaces/ws-other/chat-receipts/req-settled`, ac)).status,
    ).toBe(404);
    // Unauthed → 401.
    expect((await req(ctx.app, `/api/v1/workspaces/${ws}/chat-receipts/req-settled`)).status).toBe(
      401,
    );
  });

  test("workspace admin sees all workspace receipts incl. members' private costs", async () => {
    await before();
    const carolSettled = await req(
      ctx.app,
      `/api/v1/workspaces/${ws}/chat-receipts/req-settled`,
      cc,
    );
    expect(carolSettled.status).toBe(200);
    const carolBob = (await (
      await req(ctx.app, `/api/v1/workspaces/${ws}/chat-receipts/req-bob`, cc)
    ).json()) as Record<string, unknown>;
    expect(carolBob.charged_vnd).toBe(999);
    // Pending is visible to admin too.
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${ws}/chat-receipts/req-pending`, cc)).status,
    ).toBe(200);
  });
});
