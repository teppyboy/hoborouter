// Member chat policy route regressions (migration 0025): admin-only
// GET/PUT with strict exact-origin + JSON CSRF, cap validation (enabled
// requires an explicit positive cap; disabled normalizes to null), usage
// rows never reset by a policy update, self member-chat-access, and the
// chat-key lane (policy on => server-forced chat_member key owned by the
// caller; policy off => admin-only legacy chat key; members cannot mint
// generic keys; key rotation never resets the member period counter).
import { describe, test, expect, beforeAll } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { apiKeys, memberChatUsage, workspaces } from "@hoborouter/db";
import { makeApp, signUp, req, createWorkspace, userIdByEmail, q } from "./helpers";
import { memberChatPolicyRoutes } from "../src/routes/member-chat-policy";
import type { buildApp } from "../src/app";

const ORIGIN = "http://localhost:3000";
const policyUrl = (ws: string) => `/api/v1/workspaces/${ws}/member-chat-policy`;
const accessUrl = (ws: string) => `/api/v1/workspaces/${ws}/member-chat-access`;

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let adminCookie: string;
let memberCookie: string;
let outsiderCookie: string;
let ws: string;
let memberEmail: string;
const NOW = Date.now();

const putPolicy = (
  wsId: string,
  body: unknown,
  opts: { cookie?: string; origin?: string | null; contentType?: string | null } = {},
) =>
  app.handle(
    new Request(`http://localhost${policyUrl(wsId)}`, {
      method: "PUT",
      headers: {
        cookie: opts.cookie ?? adminCookie,
        ...(opts.origin !== null ? { origin: opts.origin ?? ORIGIN } : {}),
        ...(opts.contentType !== null
          ? { "content-type": opts.contentType ?? "application/json" }
          : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const seedUsage = async (userId: string, used: number) => {
  await db.insert(memberChatUsage).values({
    workspace_id: ws,
    user_id: userId,
    period_start: new Date().toISOString().slice(0, 10),
    used_vnd: used,
    created_at: NOW,
    updated_at: NOW,
  });
};

const usageOf = async (userId: string) => {
  const rows = await db
    .select({ used: memberChatUsage.used_vnd })
    .from(memberChatUsage)
    .where(
      and(
        eq(memberChatUsage.workspace_id, ws),
        eq(memberChatUsage.user_id, userId),
        eq(memberChatUsage.period_start, new Date().toISOString().slice(0, 10)),
      ),
    );
  return rows[0]?.used ?? 0;
};

beforeAll(async () => {
  const t = await makeApp();
  db = t.db;
  app = t.app.use(memberChatPolicyRoutes(t.db, t.auth)) as unknown as Awaited<
    ReturnType<typeof buildApp>
  >;
  adminCookie = await signUp(app, "mcp-admin@test.dev", "A");
  memberEmail = "mcp-member@test.dev";
  memberCookie = await signUp(app, memberEmail, "M");
  outsiderCookie = await signUp(app, "mcp-out@test.dev", "O");
  ws = "ws-mcp";
  await createWorkspace(db, ws, await userIdByEmail(db, "mcp-admin@test.dev"));
  await q(
    db,
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?, 'member')",
    ws,
    await userIdByEmail(db, memberEmail),
  );
  await q(
    db,
    "INSERT INTO wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at) VALUES (?,?, 'topup', 'VND', 0, 0, 0, ?)",
    `wal-${ws}`,
    ws,
    NOW,
  );
});

describe("member chat policy GET/PUT", () => {
  test("default policy is disabled with null cap (admin GET)", async () => {
    const res = await req(app, policyUrl(ws), { cookie: adminCookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, daily_cap_vnd: null });
  });

  test("member and outsider cannot read or write the policy", async () => {
    expect((await req(app, policyUrl(ws), { cookie: memberCookie })).status).toBe(403);
    expect((await req(app, policyUrl(ws), { cookie: outsiderCookie })).status).toBe(403);
    expect(
      (await putPolicy(ws, { enabled: true, daily_cap_vnd: 100 }, { cookie: memberCookie })).status,
    ).toBe(403);
  });

  test("PUT rejects cross-site Origin and non-JSON content types", async () => {
    expect(
      (await putPolicy(ws, { enabled: true, daily_cap_vnd: 100 }, { origin: "https://evil.test" }))
        .status,
    ).toBe(403);
    expect(
      (await putPolicy(ws, { enabled: true, daily_cap_vnd: 100 }, { origin: null })).status,
    ).toBe(403);
    expect(
      (await putPolicy(ws, { enabled: true, daily_cap_vnd: 100 }, { contentType: "text/plain" }))
        .status,
    ).toBe(415);
    // Nothing changed by the rejected mutations.
    expect((await req(app, policyUrl(ws), { cookie: adminCookie })).status).toBe(200);
    expect(await (await req(app, policyUrl(ws), { cookie: adminCookie })).json()).toEqual({
      enabled: false,
      daily_cap_vnd: null,
    });
  });

  test("enabling requires an explicit positive integer cap; disabled normalizes to null", async () => {
    expect((await putPolicy(ws, { enabled: true })).status).toBe(400);
    expect((await putPolicy(ws, { enabled: true, daily_cap_vnd: null })).status).toBe(400);
    expect((await putPolicy(ws, { enabled: true, daily_cap_vnd: 0 })).status).toBe(400);
    expect((await putPolicy(ws, { enabled: true, daily_cap_vnd: -5 })).status).toBe(400);
    expect((await putPolicy(ws, { enabled: true, daily_cap_vnd: 1.5 })).status).toBe(400);
    const ok = await putPolicy(ws, { enabled: true, daily_cap_vnd: 25000 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ enabled: true, daily_cap_vnd: 25000 });
    // Disabling with an absent cap normalizes to null.
    const off = await putPolicy(ws, { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ enabled: false, daily_cap_vnd: null });
    expect(
      (
        await db
          .select({
            enabled: workspaces.member_chat_enabled,
            cap: workspaces.member_chat_daily_cap_vnd,
          })
          .from(workspaces)
          .where(eq(workspaces.id, ws))
      )[0],
    ).toEqual({ enabled: false, cap: null });
  });

  test("policy update NEVER resets usage rows", async () => {
    await seedUsage(await userIdByEmail(db, memberEmail), 7777);
    await putPolicy(ws, { enabled: true, daily_cap_vnd: 25000 });
    await putPolicy(ws, { enabled: false });
    await putPolicy(ws, { enabled: true, daily_cap_vnd: 999 });
    expect(await usageOf(await userIdByEmail(db, memberEmail))).toBe(7777);
  });
});

describe("member-chat-access (self)", () => {
  test("member sees role/can_chat/cap/used/remaining/resets_at; outsider 404", async () => {
    const res = await req(app, accessUrl(ws), { cookie: memberCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.role).toBe("member");
    expect(body.can_chat).toBe(true);
    expect(body.daily_cap_vnd).toBe(999);
    expect(body.used_vnd).toBe(7777);
    expect(body.remaining_vnd).toBe(0);
    expect(typeof body.resets_at).toBe("number");
    expect((await req(app, accessUrl(ws), { cookie: outsiderCookie })).status).toBe(404);
  });

  test("disabled policy: can_chat false, cap and remaining null, used still reported", async () => {
    await putPolicy(ws, { enabled: false });
    const body = (await (await req(app, accessUrl(ws), { cookie: memberCookie })).json()) as Record<
      string,
      unknown
    >;
    expect(body.can_chat).toBe(false);
    expect(body.daily_cap_vnd).toBeNull();
    expect(body.remaining_vnd).toBeNull();
    expect(body.used_vnd).toBe(7777);
    await putPolicy(ws, { enabled: true, daily_cap_vnd: 999 });
  });
});

describe("chat-key lane", () => {
  const chatKeyUrl = (wsId: string) => `/api/v1/workspaces/${wsId}/chat-key`;
  const post = (url: string, cookie: string, body: Record<string, unknown> = {}) =>
    req(app, url, { method: "POST", cookie, body: { name: "k", ...body } });

  test("policy off: member cannot mint; admin gets the legacy instance chat key", async () => {
    // ensure disabled
    await putPolicy(ws, { enabled: false });
    expect((await post(chatKeyUrl(ws), memberCookie)).status).toBe(403);
    const adminRes = await post(chatKeyUrl(ws), adminCookie);
    expect(adminRes.status).toBe(201);
    const body = (await adminRes.json()) as { purpose: string; id: string };
    expect(body.purpose).toBe("chat");
    const row = (
      await db.select({ owner: apiKeys.owner_user_id }).from(apiKeys).where(eq(apiKeys.id, body.id))
    )[0];
    expect(row?.owner).toBeNull();
  });

  test("policy on: member mints a personal chat_member key; owner is server-forced to the caller", async () => {
    await putPolicy(ws, { enabled: true, daily_cap_vnd: 50000 });
    const res = await post(chatKeyUrl(ws), memberCookie, { name: "my chat key" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { purpose: string; id: string };
    expect(body.purpose).toBe("chat_member");
    const row = (
      await db
        .select({ owner: apiKeys.owner_user_id, purpose: apiKeys.purpose })
        .from(apiKeys)
        .where(eq(apiKeys.id, body.id))
    )[0];
    expect(row?.purpose).toBe("chat_member");
    expect(row?.owner).toBe(await userIdByEmail(db, memberEmail));
    // An admin minting under the policy also gets their OWN member key.
    const adminRes = await post(chatKeyUrl(ws), adminCookie);
    expect(((await adminRes.json()) as { purpose: string }).purpose).toBe("chat_member");
  });

  test("members can never mint generic keys", async () => {
    expect(
      (
        await req(app, `/api/v1/workspaces/${ws}/keys`, {
          method: "POST",
          cookie: memberCookie,
          body: { name: "g" },
        })
      ).status,
    ).toBe(403);
  });

  test("key rotation (revoke + remint) never resets the member period counter", async () => {
    // Accumulate on the existing period row (rotation must never reset it).
    await db.execute(
      sql`UPDATE member_chat_usage SET used_vnd = used_vnd + 111 WHERE workspace_id = ${ws} AND user_id = ${await userIdByEmail(db, memberEmail)} AND period_start = ${new Date().toISOString().slice(0, 10)}`,
    ); // total 7888
    // Revoke the member's key and mint a fresh one.
    const keys = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.workspace_id, ws),
          eq(apiKeys.purpose, "chat_member"),
          eq(apiKeys.owner_user_id, await userIdByEmail(db, memberEmail)),
        ),
      );
    const oldId = keys[0]!.id;
    expect(
      (
        await req(app, `/api/v1/workspaces/${ws}/keys/${oldId}`, {
          method: "DELETE",
          cookie: adminCookie,
        })
      ).status,
    ).toBe(200);
    const fresh = await post(chatKeyUrl(ws), memberCookie);
    expect(fresh.status).toBe(201);
    expect(((await fresh.json()) as { id: string }).id).not.toBe(oldId);
    // The historical counter is keyed by (workspace, user, period), not key.
    expect(await usageOf(await userIdByEmail(db, memberEmail))).toBe(7888);
  });
});
