// Admin user create/remove routes: contract per lane spec. Real HTTP against
// the built app; DB helpers only for setup (admin flag, workspaces, rows).
import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { q } from "./helpers";
import {
  addMember,
  cookieOf,
  createWorkspace,
  makeApp,
  makeInstanceAdmin,
  req,
  signUp,
  userIdByEmail,
} from "./helpers";

const PASSWORD = "Correct-Horse-Battery-Staple-1";

// Close each test's pool after the test: Bun SQL pools hold connections until
// closed and the test Postgres has a finite connection budget.
let drops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of drops) await d();
  drops = [];
});

async function makeAdmin() {
  const made = await makeApp();
  drops.push(made.close);
  const { db, app } = made;
  const email = `admin-${crypto.randomUUID()}@example.com`;
  const cookie = await signUp(app, email, "Admin");
  await makeInstanceAdmin(db, await userIdByEmail(db, email));
  return { db, app, cookie };
}

async function login(app: Awaited<ReturnType<typeof makeApp>>["app"], email: string, password = PASSWORD) {
  return app.handle(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
}

describe("POST /api/v1/admin/users", () => {
  test("creates user, then login works", async () => {
    const { app, cookie } = await makeAdmin();
    const res = await req(app, "/api/v1/admin/users", {
      method: "POST",
      cookie,
      body: { name: "New User", email: "new@example.com", password: PASSWORD },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.email).toBe("new@example.com");
    expect(body.instance_admin).toBe(false);
    expect(typeof body.id).toBe("string");
    const loginRes = await login(app, "new@example.com");
    expect(loginRes.status).toBe(200);
  });

  test("instance_admin flag inserts admin row", async () => {
    const { db, app, cookie } = await makeAdmin();
    const res = await req(app, "/api/v1/admin/users", {
      method: "POST",
      cookie,
      body: { name: "A", email: "a2@example.com", password: PASSWORD, instance_admin: true },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).instance_admin).toBe(true);
    const row = await q(
      db,
      "select 1 from instance_admins where user_id = ?",
      await userIdByEmail(db, "a2@example.com"),
    );
    expect(row.length).toBe(1);
  });

  test("duplicate email 409 EMAIL_TAKEN", async () => {
    const { app, cookie } = await makeAdmin();
    const res = await req(app, "/api/v1/admin/users", {
      method: "POST",
      cookie,
      body: { name: "A", email: "dup@example.com", password: PASSWORD },
    });
    expect(res.status).toBe(201);
    const dup = await req(app, "/api/v1/admin/users", {
      method: "POST",
      cookie,
      body: { name: "B", email: "dup@example.com", password: PASSWORD },
    });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe("EMAIL_TAKEN");
  });

  test("400 INVALID on password over 200 chars", async () => {
    const { app, cookie } = await makeAdmin();
    const res = await req(app, "/api/v1/admin/users", {
      method: "POST",
      cookie,
      body: { name: "A", email: "longpw@example.com", password: "x".repeat(201) },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID");
  });

  test("400 INVALID on email over 254 chars", async () => {
    const { app, cookie } = await makeAdmin();
    const longEmail = `${"x".repeat(250)}@example.com`;
    const res = await req(app, "/api/v1/admin/users", {
      method: "POST",
      cookie,
      body: { name: "A", email: longEmail, password: PASSWORD },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID");
  });

  test("non-admin 403", async () => {
    const made = await makeApp();
    drops.push(made.close);
    const { app } = made;
    const cookie = await signUp(app, `u-${crypto.randomUUID()}@example.com`);
    const res = await req(app, "/api/v1/admin/users", {
      method: "POST",
      cookie,
      body: { name: "A", email: "x@example.com", password: PASSWORD },
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/v1/admin/users/:id", () => {
  test("removes user; login then fails", async () => {
    const { app, cookie } = await makeAdmin();
    const created = await (
      await req(app, "/api/v1/admin/users", {
        method: "POST",
        cookie,
        body: { name: "Gone", email: "gone@example.com", password: PASSWORD },
      })
    ).json();
    const res = await req(app, `/api/v1/admin/users/${created.id}`, { method: "DELETE", cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    const loginRes = await login(app, "gone@example.com");
    expect(loginRes.status).toBe(401);
  });

  test("self removal 400 CANNOT_REMOVE_SELF", async () => {
    const { db, app, cookie } = await makeAdmin();
    // Second admin so actor is not the last admin; self guard then wins.
    await req(app, "/api/v1/admin/users", {
      method: "POST",
      cookie,
      body: { name: "A2", email: "a2@example.com", password: PASSWORD, instance_admin: true },
    });
    const selfId = (
      await q<{ id: string }>(
        db,
        "select id from users where email like 'admin-%@example.com' limit 1",
      )
    )[0]!.id;
    const res = await req(app, `/api/v1/admin/users/${selfId}`, { method: "DELETE", cookie });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("CANNOT_REMOVE_SELF");
  });

  test("last instance admin 409 LAST_ADMIN (sole admin removing self)", async () => {
    const { db, app, cookie } = await makeAdmin();
    const adminId = (
      await q<{ id: string }>(
        db,
        "select id from users where email like 'admin-%@example.com' limit 1",
      )
    )[0]!.id;
    const res = await req(app, `/api/v1/admin/users/${adminId}`, { method: "DELETE", cookie });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("LAST_ADMIN");
  });

  test("removing one of two admins succeeds; survivor keeps access", async () => {
    const { db, app, cookie } = await makeAdmin();
    const adminId = (
      await q<{ id: string }>(
        db,
        "select id from users where email like 'admin-%@example.com' limit 1",
      )
    )[0]!.id;
    await req(app, "/api/v1/admin/users", {
      method: "POST",
      cookie,
      body: { name: "A2", email: "a2@example.com", password: PASSWORD, instance_admin: true },
    });
    // Login as second admin, remove the first (2 admins -> 1): ok.
    const secondLogin = await login(app, "a2@example.com");
    expect(secondLogin.status).toBe(200);
    const secondCookie = cookieOf(secondLogin);
    const ok = await req(app, `/api/v1/admin/users/${adminId}`, {
      method: "DELETE",
      cookie: secondCookie,
    });
    expect(ok.status).toBe(200);
    // a3 (second admin) exists, so a2 is no longer last: a3 removes a2 -> 200.
    await req(app, "/api/v1/admin/users", {
      method: "POST",
      cookie: secondCookie,
      body: { name: "A3", email: "a3@example.com", password: PASSWORD, instance_admin: true },
    });
    const thirdLogin = await login(app, "a3@example.com");
    expect(thirdLogin.status).toBe(200);
    const res = await req(app, `/api/v1/admin/users/${await userIdByEmail(db, "a2@example.com")}`, {
      method: "DELETE",
      cookie: cookieOf(thirdLogin),
    });
    expect(res.status).toBe(200);
  });

  test("sole owner 409 lists workspaces", async () => {
    const { db, app, cookie } = await makeAdmin();
    const created = await (
      await req(app, "/api/v1/admin/users", {
        method: "POST",
        cookie,
        body: { name: "Owner", email: "owner@example.com", password: PASSWORD },
      })
    ).json();
    await createWorkspace(db, "ws-1", created.id, "Solo WS");
    await createWorkspace(db, "ws-2", created.id, "Second WS");
    const res = await req(app, `/api/v1/admin/users/${created.id}`, { method: "DELETE", cookie });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("SOLE_OWNER");
    expect(body.error.workspaces).toEqual([
      { id: "ws-1", name: "Solo WS" },
      { id: "ws-2", name: "Second WS" },
    ]);
    // Co-owner added on one workspace -> only the other workspace is listed.
    const adminEmail = (
      await q<{ email: string }>(
        db,
        "select email from users where email like 'admin-%@example.com' limit 1",
      )
    )[0]!.email;
    await addMember(db, "ws-1", await userIdByEmail(db, adminEmail), "owner");
    const res2 = await req(app, `/api/v1/admin/users/${created.id}`, { method: "DELETE", cookie });
    expect(res2.status).toBe(409);
    expect(((await res2.json()) as { error: { workspaces: unknown[] } }).error.workspaces).toEqual([
      { id: "ws-2", name: "Second WS" },
    ]);
  });

  test("unknown user 404", async () => {
    const { app, cookie } = await makeAdmin();
    const res = await req(app, "/api/v1/admin/users/nope", { method: "DELETE", cookie });
    expect(res.status).toBe(404);
  });

  test("history preserved: requests/ledger/payments/audit counts unchanged", async () => {
    const { db, app, cookie } = await makeAdmin();
    const created = await (
      await req(app, "/api/v1/admin/users", {
        method: "POST",
        cookie,
        body: { name: "Hist", email: "hist@example.com", password: PASSWORD },
      })
    ).json();
    const now = Date.now();
    await db.execute(sql`insert into workspaces (id, name, status, created_at) values ('ws-h','H','active',${now})`);
    await db.execute(sql`insert into workspace_members (workspace_id, user_id, role) values ('ws-h',${created.id},'member')`);
    await db.execute(sql`insert into wallets (id, workspace_id, balance, reserved, created_at) values ('w-h','ws-h',1000,0,${now})`);
    await db.execute(sql`insert into ledger_entries (id, wallet_id, direction, amount, kind, balance_after, created_at) values ('le-h','w-h','credit',1000,'topup',1000,${now})`);
    await db.execute(sql`insert into payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) values ('p-h','ws-h',1000,'succeeded','manual','ord-h',${now})`);
    await db.execute(sql`insert into audit_log (id, actor_user_id, action, target, created_at) values ('au-h',${created.id}, 'user.create', 'x', ${now})`);
    const snap = async () =>
      (
        await q<{
          r: string;
          l: string;
          p: string;
          a: string;
        }>(
          db,
          "select (select count(*) from requests) r, (select count(*) from ledger_entries) l, (select count(*) from payments) p, (select count(*) from audit_log where action != 'user.remove') a",
        )
      )[0]!;
    const before = await snap();
    const res = await req(app, `/api/v1/admin/users/${created.id}`, { method: "DELETE", cookie });
    expect(res.status).toBe(200);
    expect(await snap()).toEqual(before);
    // User row anonymized (FK-blocked by audit_log/membership), not deleted.
    const row = (
      await q<{ email: string; name: string; image: string | null }>(
        db,
        "select email, name, image from users where id = ?",
        created.id,
      )
    )[0]!;
    expect(row.email).toBe(`deleted+${created.id}@invalid`);
    expect(row.name).toBe("Deleted user");
    expect(row.image).toBeNull();
    expect(await login(app, "hist@example.com").then((r) => r.status)).toBe(401);
  });
});
