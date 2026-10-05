// Chat conversations routes: privacy (owner+workspace only — even workspace
// owner/admin and instance admins get 404 for other users' chats), optimistic
// version saves (stale → 409, never overwrite), validation caps, archive
// instead of delete, and the money invariant: chat history never charges.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { createAuth } from "../src/auth";
import { buildApp } from "../src/app";
import {
  signUp,
  req,
  createWorkspace,
  addMember,
  userIdByEmail,
  makeInstanceAdmin,
  q,
} from "./helpers";
import { sql } from "drizzle-orm";

const A = "ws-chat-a";
const B = "ws-chat-b";
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const CAROL = "carol@example.com";
const OUTSIDER = "outsider@example.com";

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let alice: string, bob: string, carol: string, outsider: string;
let aliceId = "";

const json = (res: Response) => res.json() as Promise<Record<string, unknown>>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  const auth = createAuth(db);
  app = await buildApp({ db, auth });

  alice = await signUp(app, ALICE, "A");
  bob = await signUp(app, BOB, "B");
  carol = await signUp(app, CAROL, "C");
  outsider = await signUp(app, OUTSIDER, "O");
  aliceId = await userIdByEmail(db, ALICE);

  // A: alice owner, bob member. B: carol owner. A seeded wallet (balance 0)
  // proves the money invariant: chat history must not move it.
  await createWorkspace(db, A, aliceId, "A");
  await db.execute(
    sql`INSERT INTO wallets (id, workspace_id, balance, reserved, created_at) VALUES ('wal-chat-a', ${A}, 0, 0, ${Date.now()})`,
  );
  await addMember(db, A, await userIdByEmail(db, BOB), "member");
  await createWorkspace(db, B, await userIdByEmail(db, CAROL), "B");
  // Instance admin status must NOT bypass per-user chat privacy.
  await makeInstanceAdmin(db, await userIdByEmail(db, BOB));
});

describe("chat conversations routes", () => {
  test("unauthenticated requests are 401", async () => {
    for (const [path, method] of [
      [`/api/v1/workspaces/${A}/chats`, "GET"],
      [`/api/v1/workspaces/${A}/chats`, "POST"],
      [`/api/v1/workspaces/${A}/chats/x`, "GET"],
      [`/api/v1/workspaces/${A}/chats/x`, "PUT"],
      [`/api/v1/workspaces/${A}/chats/x`, "PATCH"],
    ] as const) {
      const res = await req(app, path, { method });
      expect(res.status).toBe(401);
    }
  });

  test("non-member gets 403, unknown workspace is indistinguishable (403, no leak)", async () => {
    const res = await req(app, `/api/v1/workspaces/${A}/chats`, { method: "GET", cookie: carol });
    expect(res.status).toBe(403);
    const res2 = await req(app, "/api/v1/workspaces/nope/chats", { method: "GET", cookie: carol });
    expect(res2.status).toBe(403);
  });

  let aliceChat = "";

  test("POST creates a 'New chat' conversation, no charge", async () => {
    // Canonical contract: POST takes no body; model starts null.
    const res = await req(app, `/api/v1/workspaces/${A}/chats`, {
      method: "POST",
      cookie: alice,
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.title).toBe("New chat");
    expect(body.version).toBe(1);
    expect(body.model).toBeNull();
    expect(body.messages).toEqual([]);
    aliceChat = body.id as string;
    const ledger = await q(db, "SELECT id FROM ledger_entries LIMIT 1");
    expect(ledger).toHaveLength(0);
  });

  test("list is per-user: bob sees only his conversations, not alice's", async () => {
    const bobRes = await req(app, `/api/v1/workspaces/${A}/chats`, {
      method: "POST",
      cookie: bob,
      body: {},
    });
    expect(bobRes.status).toBe(201);
    const res = await req(app, `/api/v1/workspaces/${A}/chats`, { method: "GET", cookie: bob });
    expect(res.status).toBe(200);
    const body = await json(res);
    const data = body.data as { id: string }[];
    expect(data).toHaveLength(1);
    expect(data[0]?.id).not.toBe(aliceChat);
    expect(body.nextCursor).toBeNull();
  });

  test("other users' chats are 404 to members (even instance admins); non-members 403", async () => {
    // bob is a member AND an instance admin → 404 (no leak, no admin bypass).
    const res = await req(app, `/api/v1/workspaces/${A}/chats/${aliceChat}`, {
      method: "GET",
      cookie: bob,
    });
    expect(res.status).toBe(404);
    // carol/outsider are not members of A → 403 membership gate.
    for (const cookie of [carol, outsider]) {
      const res = await req(app, `/api/v1/workspaces/${A}/chats/${aliceChat}`, {
        method: "GET",
        cookie,
      });
      expect(res.status).toBe(403);
    }
  });

  test("chat under a different workspace id is 404 (no existence leak)", async () => {
    const res = await req(app, `/api/v1/workspaces/${B}/chats/${aliceChat}`, {
      method: "GET",
      cookie: carol,
    });
    expect(res.status).toBe(404);
  });

  test("PUT with the current version saves and increments server-side", async () => {
    const res = await req(app, `/api/v1/workspaces/${A}/chats/${aliceChat}`, {
      method: "PUT",
      cookie: alice,
      body: {
        version: 1,
        title: "My chat",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.version).toBe(2);
    expect(body.title).toBe("My chat");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("PUT with a stale version is 409 and does NOT overwrite", async () => {
    const res = await req(app, `/api/v1/workspaces/${A}/chats/${aliceChat}`, {
      method: "PUT",
      cookie: alice,
      body: { version: 1, title: "Stale", messages: [{ role: "user", content: "stale" }] },
    });
    expect(res.status).toBe(409);
    const cur = await req(app, `/api/v1/workspaces/${A}/chats/${aliceChat}`, {
      method: "GET",
      cookie: alice,
    });
    const body = await json(cur);
    expect(body.title).toBe("My chat"); // newer save survived
  });

  test("PUT validation: role whitelist, caps, and 512 KiB body limit", async () => {
    const put = (body: unknown) =>
      req(app, `/api/v1/workspaces/${A}/chats/${aliceChat}`, {
        method: "PUT",
        cookie: alice,
        body,
      });
    expect((await put({ version: 2, messages: [{ role: "system", content: "x" }] })).status).toBe(
      400,
    );
    expect(
      (await put({ version: 2, messages: [{ role: "user", content: "x" }, "nope"] })).status,
    ).toBe(400);
    expect((await put({ version: 2, title: "", messages: [] })).status).toBe(400);
    expect((await put({ version: 2, title: "a".repeat(121), messages: [] })).status).toBe(400);
    expect(
      (
        await put({
          version: 2,
          messages: Array.from({ length: 501 }, () => ({ role: "user", content: "x" })),
        })
      ).status,
    ).toBe(400);
    expect(
      (await put({ version: 2, messages: [{ role: "user", content: "x".repeat(64 * 1024 + 1) }] }))
        .status,
    ).toBe(400);
    // Over the hard body cap → 413 before full processing.
    const big = JSON.stringify({
      version: 2,
      messages: [{ role: "user", content: "x".repeat(600 * 1024) }],
    });
    const res = await app.handle(
      new Request(`http://localhost/api/v1/workspaces/${A}/chats/${aliceChat}`, {
        method: "PUT",
        headers: {
          cookie: alice,
          "content-type": "application/json",
          "content-length": String(big.length),
        },
        body: big,
      }),
    );
    expect(res.status).toBe(413);
  });

  test("archive: PATCH archived:true hides from the list and is idempotent", async () => {
    const res = await req(app, `/api/v1/workspaces/${A}/chats/${aliceChat}`, {
      method: "PATCH",
      cookie: alice,
      body: { archived: true },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(typeof body.archived_at).toBe("number");
    const again = await req(app, `/api/v1/workspaces/${A}/chats/${aliceChat}`, {
      method: "PATCH",
      cookie: alice,
      body: { archived: true },
    });
    expect(again.status).toBe(200);
    const list = await req(app, `/api/v1/workspaces/${A}/chats`, { method: "GET", cookie: alice });
    const data = ((await json(list)).data as { id: string }[]).map((c) => c.id);
    expect(data).not.toContain(aliceChat);
    // Archived, not deleted: the snapshot is still loadable by the owner.
    const load = await req(app, `/api/v1/workspaces/${A}/chats/${aliceChat}`, {
      method: "GET",
      cookie: alice,
    });
    expect(load.status).toBe(200);
  });

  test("no DELETE data endpoint exists", async () => {
    const res = await req(app, `/api/v1/workspaces/${A}/chats/${aliceChat}`, {
      method: "DELETE",
      cookie: alice,
    });
    expect(res.status).toBe(404);
  });

  test("chat history never charges: no ledger rows, wallet untouched", async () => {
    const ledger = await q(db, "SELECT id FROM ledger_entries LIMIT 1");
    expect(ledger).toHaveLength(0);
    const wallet = await q(db, "SELECT balance, reserved FROM wallets WHERE workspace_id = ?", A);
    expect(wallet[0]?.balance).toBe(0);
    expect(wallet[0]?.reserved).toBe(0);
  });

  test("audit trail: chat.rename and chat.archive rows written, never message/title content", async () => {
    const audits = await q<{
      action: string;
      target: string;
      actor_user_id: string | null;
      workspace_id: string | null;
      detail: unknown;
    }>(
      db,
      "SELECT action, target, actor_user_id, workspace_id, detail FROM audit_log WHERE action LIKE 'chat.%'",
    );
    // Successful title change ("New chat" -> "My chat") audited exactly once;
    // stale (409) and invalid (400) PUTs audit nothing.
    const renames = audits.filter((a) => a.action === "chat.rename" && a.target === aliceChat);
    expect(renames.length).toBe(1);
    expect(renames[0]!.actor_user_id).toBe(aliceId);
    expect(renames[0]!.workspace_id).toBe(A);
    // Repeated archive is idempotent: exactly one chat.archive audit row.
    const archives = audits.filter((a) => a.action === "chat.archive" && a.target === aliceChat);
    expect(archives.length).toBe(1);
    expect(archives[0]!.actor_user_id).toBe(aliceId);
    // Details carry field names only — never titles, messages, or reasoning.
    const serialized = JSON.stringify(audits.map((a) => a.detail));
    expect(serialized).not.toContain("My chat");
    expect(serialized).not.toContain("hi");
    expect(serialized).not.toContain("stale");
  });
});
