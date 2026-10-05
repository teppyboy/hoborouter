// Admin user-edit routes (PATCH name/email, POST reset-password): real HTTP
// against real createAuth + real Postgres. Auth flows go through Better Auth
// endpoints (cookies), DB helpers only for seeding/assertions.
import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { sql } from "drizzle-orm";
import { createTestDb, type Db } from "@hoborouter/db";
import { createAuth } from "../src/auth";
import { adminUserEditRoutes } from "../src/routes/admin-user-edit";
import { cookieOf, q } from "./helpers";

const PASSWORD = "Correct-Horse-Battery-Staple-1";
const NEW_PASSWORD = "Fresh-Correct-Horse-Staple-42";

let drops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of drops) await d();
  drops = [];
});

// Minimal app: Better Auth endpoints (real handler) + routes under test.
// No app.ts wiring — the route module is mounted standalone.
async function newApp() {
  const t = await createTestDb();
  drops.push(t.drop);
  const db = t.db;
  const auth = createAuth(db);
  const app = new Elysia()
    .all("/api/auth/*", ({ request }) => auth.handler(request))
    .use(adminUserEditRoutes(db, auth));
  return { db, auth, app };
}

type App = Awaited<ReturnType<typeof newApp>>["app"];

const req = (
  app: App,
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown; raw?: string } = {},
) => {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined || opts.raw !== undefined)
    headers["content-type"] = "application/json";
  return app.handle(
    new Request("http://localhost" + path, {
      method: opts.method ?? "GET",
      headers,
      body:
        opts.raw !== undefined
          ? opts.raw
          : opts.body !== undefined
            ? JSON.stringify(opts.body)
            : undefined,
    }),
  );
};

async function signUpAs(app: App, email: string, name = "U"): Promise<string> {
  const res = await app.handle(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, name }),
    }),
  );
  if (!res.ok) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  return cookieOf(res);
}

const login = (app: App, email: string, password: string) =>
  app.handle(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
const getSession = (app: App, cookie: string) =>
  app.handle(new Request("http://localhost/api/auth/get-session", { headers: { cookie } }));

async function makeAdmin() {
  const ctx = await newApp();
  const email = `admin-${crypto.randomUUID()}@example.com`;
  const cookie = await signUpAs(ctx.app, email, "Admin");
  await ctx.db.execute(
    sql`insert into instance_admins (user_id, created_at) values ((select id from users where email = ${email}), ${Date.now()})`,
  );
  return { ...ctx, adminCookie: cookie, adminEmail: email };
}

// Temporarily reject ALL audit_log inserts (disposable DB): the admin routes
// must roll their change back atomically when the audit write fails.
async function withBlockedAudits<T>(db: Db, run: () => Promise<T>): Promise<T> {
  await db.execute(
    sql`CREATE FUNCTION reject_admin_audit() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION 'audit rejected'; RETURN NEW; END $fn$ LANGUAGE plpgsql`,
  );
  await db.execute(
    sql`CREATE TRIGGER reject_admin_audit_ins BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_admin_audit()`,
  );
  try {
    return await run();
  } finally {
    await db.execute(sql`DROP TRIGGER reject_admin_audit_ins ON audit_log`);
    await db.execute(sql`DROP FUNCTION reject_admin_audit()`);
  }
}

const uidByEmail = async (db: Db, email: string) =>
  (await q<{ id: string }>(db, "select id from users where email = ?", email))[0]!.id;

// Seed a deleted/anonymized user row exactly as removeUserIdentity leaves it.
async function seedAnonymized(db: Db, id: string) {
  await db.execute(
    sql`insert into users (id, name, email, email_verified, created_at, updated_at) values (${id}, 'Deleted user', ${`deleted+${id}@invalid`}, false, ${Date.now()}, ${Date.now()})`,
  );
}

describe("PATCH /api/v1/admin/users/:id", () => {
  test("updates name and email; returns {user:{id,name,email}}", async () => {
    const { db, app, adminCookie } = await makeAdmin();
    const email = `t-${crypto.randomUUID()}@example.com`;
    await signUpAs(app, email);
    const uid = await uidByEmail(db, email);
    const res = await req(app, `/api/v1/admin/users/${uid}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { name: "  Renamed  ", email: "  NEW.Name@Example.COM " },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toEqual({ id: uid, name: "Renamed", email: "new.name@example.com" });
    const row = (
      await q(db, "select name, email, email_verified from users where id = ?", uid)
    )[0]!;
    expect(row.name).toBe("Renamed");
    expect(row.email).toBe("new.name@example.com");
  });

  test("400 on malformed/invalid bodies", async () => {
    const { db, app, adminCookie } = await makeAdmin();
    const email = `t-${crypto.randomUUID()}@example.com`;
    await signUpAs(app, email);
    const uid = await uidByEmail(db, email);
    const cases: { raw?: string; body?: unknown }[] = [
      { raw: "not json" },
      { body: {} },
      { body: { name: "" } },
      { body: { name: "x".repeat(81) } },
      { body: { email: "not-an-email" } },
      { body: { email: `${"x".repeat(250)}@example.com` } },
      { body: { name: 5 } },
    ];
    for (const c of cases) {
      const res = await req(app, `/api/v1/admin/users/${uid}`, {
        method: "PATCH",
        cookie: adminCookie,
        ...c,
      });
      expect(res.status).toBe(400);
    }
  });

  test("404 unknown id and 404 for anonymized user", async () => {
    const { db, app, adminCookie } = await makeAdmin();
    expect(
      (
        await req(app, `/api/v1/admin/users/nope`, {
          method: "PATCH",
          cookie: adminCookie,
          body: { name: "X" },
        })
      ).status,
    ).toBe(404);
    const ghostId = crypto.randomUUID();
    await seedAnonymized(db, ghostId);
    expect(
      (
        await req(app, `/api/v1/admin/users/${ghostId}`, {
          method: "PATCH",
          cookie: adminCookie,
          body: { name: "Revived" },
        })
      ).status,
    ).toBe(404);
  });

  test("401 without session, 403 for non-admin", async () => {
    const { app } = await newApp();
    const cookie = await signUpAs(app, `t-${crypto.randomUUID()}@example.com`);
    expect(
      (await req(app, "/api/v1/admin/users/whatever", { method: "PATCH", body: { name: "X" } }))
        .status,
    ).toBe(401);
    expect(
      (
        await req(app, "/api/v1/admin/users/whatever", {
          method: "PATCH",
          cookie,
          body: { name: "X" },
        })
      ).status,
    ).toBe(403);
  });

  test("duplicate email → 409 EMAIL_TAKEN (precheck)", async () => {
    const { db, app, adminCookie } = await makeAdmin();
    const targetEmail = `target-${crypto.randomUUID()}@example.com`;
    await signUpAs(app, targetEmail);
    const target = await uidByEmail(db, targetEmail);
    const otherEmail = `taken-${crypto.randomUUID()}@example.com`;
    await signUpAs(app, otherEmail);
    const res = await req(app, `/api/v1/admin/users/${target}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { email: otherEmail },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("EMAIL_TAKEN");
  });

  test("concurrent duplicate email race → one 200, one 409 EMAIL_TAKEN", async () => {
    const { db, app, adminCookie } = await makeAdmin();
    const e1 = `race-a-${crypto.randomUUID()}@example.com`;
    const e2 = `race-b-${crypto.randomUUID()}@example.com`;
    await signUpAs(app, e1);
    await signUpAs(app, e2);
    const id1 = await uidByEmail(db, e1);
    const id2 = await uidByEmail(db, e2);
    const shared = `shared-${crypto.randomUUID()}@example.com`;
    const [r1, r2] = await Promise.all([
      req(app, `/api/v1/admin/users/${id1}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: { email: shared },
      }),
      req(app, `/api/v1/admin/users/${id2}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: { email: shared },
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  test("actual email change: emailVerified=false, all target sessions revoked; name-only keeps sessions", async () => {
    const { db, app, adminCookie } = await makeAdmin();
    const email = `sess-${crypto.randomUUID()}@example.com`;
    const cookie = await signUpAs(app, email);
    const uid = await uidByEmail(db, email);
    // Name-only: sessions survive, emailVerified untouched.
    const verifiedBefore = (
      await q<{ email_verified: boolean }>(db, "select email_verified from users where id = ?", uid)
    )[0]!.email_verified;
    expect(
      (
        await req(app, `/api/v1/admin/users/${uid}`, {
          method: "PATCH",
          cookie: adminCookie,
          body: { name: "Just Name" },
        })
      ).status,
    ).toBe(200);
    expect((await getSession(app, cookie)).status).toBe(200);
    expect(
      (
        await q<{ email_verified: boolean }>(
          db,
          "select email_verified from users where id = ?",
          uid,
        )
      )[0]!.email_verified,
    ).toBe(verifiedBefore);
    // Same email (trimmed/uppercased input) → no change, session survives.
    expect(
      (
        await req(app, `/api/v1/admin/users/${uid}`, {
          method: "PATCH",
          cookie: adminCookie,
          body: { email: `  ${email.toUpperCase()} ` },
        })
      ).status,
    ).toBe(200);
    expect((await getSession(app, cookie)).status).toBe(200);
    // Actual email change: unverified + all sessions revoked.
    const newEmail = `moved-${crypto.randomUUID()}@example.com`;
    expect(
      (
        await req(app, `/api/v1/admin/users/${uid}`, {
          method: "PATCH",
          cookie: adminCookie,
          body: { email: newEmail },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await q<{ email_verified: boolean }>(
          db,
          "select email_verified from users where id = ?",
          uid,
        )
      )[0]!.email_verified,
    ).toBe(false);
    expect(await q(db, "select 1 from session where user_id = ?", uid)).toEqual([]);
    expect((await getSession(app, cookie)).status).toBe(200);
    expect(await (await getSession(app, cookie)).json()).toBe(null);
    expect((await login(app, newEmail, PASSWORD)).status).toBe(200);
  });

  test("no role changes; financial tables untouched", async () => {
    const { db, app, adminCookie } = await makeAdmin();
    const email = `role-${crypto.randomUUID()}@example.com`;
    await signUpAs(app, email);
    const uid = await uidByEmail(db, email);
    const paymentsBefore = (await q<{ n: number }>(db, "select count(*) as n from payments"))[0]!.n;
    const usageBefore = (await q<{ n: number }>(db, "select count(*) as n from usage_logs"))[0]!.n;
    const res = await req(app, `/api/v1/admin/users/${uid}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { name: "NoRoles" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("instance_admin");
    expect(await q(db, "select 1 from instance_admins where user_id = ?", uid)).toEqual([]);
    expect((await q<{ n: number }>(db, "select count(*) as n from payments"))[0]!.n).toBe(
      paymentsBefore,
    );
    expect((await q<{ n: number }>(db, "select count(*) as n from usage_logs"))[0]!.n).toBe(
      usageBefore,
    );
  });

  test("audit insert failure rolls back the edit: row, sessions, audit all unchanged", async () => {
    const { db, app, adminCookie } = await makeAdmin();
    const email = `rb-${crypto.randomUUID()}@example.com`;
    const targetCookie = await signUpAs(app, email);
    const uid = await uidByEmail(db, email);
    const verifiedBefore = (
      await q<{ email_verified: boolean }>(db, "select email_verified from users where id = ?", uid)
    )[0]!.email_verified;
    const newEmail = `rb2-${crypto.randomUUID()}@example.com`;
    await withBlockedAudits(db, async () => {
      const res = await req(app, `/api/v1/admin/users/${uid}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: { name: "Rolled Back", email: newEmail },
      });
      expect(res.status).toBe(500);
      // Update + session revocation + audit are one transaction: nothing landed.
      const row = (
        await q(db, "select name, email, email_verified from users where id = ?", uid)
      )[0]!;
      expect(row.name).toBe("U");
      expect(row.email).toBe(email);
      expect(row.email_verified).toBe(verifiedBefore);
      expect(await q(db, "select 1 from session where user_id = ?", uid)).not.toEqual([]);
      expect((await getSession(app, targetCookie)).status).toBe(200);
      expect(await q(db, "select 1 from audit_log where target = ?", uid)).toEqual([]);
    });
    // Trigger dropped: the same edit now succeeds normally.
    expect(
      (
        await req(app, `/api/v1/admin/users/${uid}`, {
          method: "PATCH",
          cookie: adminCookie,
          body: { name: "Rolled Back", email: newEmail },
        })
      ).status,
    ).toBe(200);
  });

  test("audit user.update has safe fields only, no email values or secrets", async () => {
    const { db, app, adminCookie, adminEmail } = await makeAdmin();
    const email = `aud-${crypto.randomUUID()}@example.com`;
    await signUpAs(app, email);
    const uid = await uidByEmail(db, email);
    await req(app, `/api/v1/admin/users/${uid}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { name: "Audit Name", email: `aud2-${crypto.randomUUID()}@example.com` },
    });
    const rows = await q<{ action: string; detail: unknown; target: string }>(
      db,
      "select action, detail, target from audit_log where action = 'user.update' and target = ?",
      uid,
    );
    expect(rows.length).toBe(1);
    const detail = rows[0]!.detail;
    expect(typeof detail === "string" ? JSON.parse(detail) : detail).toEqual({
      fields: ["name", "email"],
    });
    const raw = JSON.stringify(rows[0]);
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain("aud-"); // old email value never recorded
    expect(raw).not.toContain(adminEmail);
  });
});

describe("POST /api/v1/admin/users/:id/reset-password", () => {
  test("reset works: old login fails, new login works, old sessions revoked, hash not plaintext", async () => {
    const { db, app, adminCookie } = await makeAdmin();
    const email = `reset-${crypto.randomUUID()}@example.com`;
    const cookie = await signUpAs(app, email);
    const uid = await uidByEmail(db, email);
    const res = await req(app, `/api/v1/admin/users/${uid}/reset-password`, {
      method: "POST",
      cookie: adminCookie,
      body: { newPassword: NEW_PASSWORD },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    // Old credential no longer signs in; new one does.
    expect((await login(app, email, PASSWORD)).status).toBe(401);
    expect((await login(app, email, NEW_PASSWORD)).status).toBe(200);
    // Old session cookie revoked.
    expect(await (await getSession(app, cookie)).json()).toBe(null);
    // Stored value is a salted hash, never the plaintext.
    const stored = (
      await q<{ password: string }>(
        db,
        "select password from account where user_id = ? and provider_id = 'credential'",
        uid,
      )
    )[0]!.password!;
    expect(stored).not.toBe(NEW_PASSWORD);
    expect(stored).not.toContain(NEW_PASSWORD);
    // Salted: a second reset produces a different hash.
    await req(app, `/api/v1/admin/users/${uid}/reset-password`, {
      method: "POST",
      cookie: adminCookie,
      body: { newPassword: NEW_PASSWORD },
    });
    const stored2 = (
      await q<{ password: string }>(
        db,
        "select password from account where user_id = ? and provider_id = 'credential'",
        uid,
      )
    )[0]!.password!;
    expect(stored2).not.toBe(stored);
  });

  test("OAuth-only target: credential account added, OAuth account untouched", async () => {
    const { db, app, adminCookie } = await makeAdmin();
    const email = `oauth-${crypto.randomUUID()}@example.com`;
    await signUpAs(app, email);
    const uid = await uidByEmail(db, email);
    // Strip credential account, leave a fake OAuth account.
    await db.execute(
      sql`delete from account where user_id = ${uid} and provider_id = 'credential'`,
    );
    await db.execute(sql`
      insert into account (id, account_id, provider_id, user_id, created_at, updated_at)
      values (${crypto.randomUUID()}, 'google-sub-1', 'google', ${uid}, ${Date.now()}, ${Date.now()})`);
    const res = await req(app, `/api/v1/admin/users/${uid}/reset-password`, {
      method: "POST",
      cookie: adminCookie,
      body: { newPassword: NEW_PASSWORD },
    });
    expect(res.status).toBe(200);
    const accounts = await q<{ provider_id: string; password: string | null }>(
      db,
      "select provider_id, password from account where user_id = ? order by provider_id",
      uid,
    );
    expect(accounts.length).toBe(2);
    const oauth = accounts.find((a) => a.provider_id === "google")!;
    const cred = accounts.find((a) => a.provider_id === "credential")!;
    expect(oauth.password).toBe(null); // OAuth account never touched
    expect(cred.password).toBeTruthy();
    expect((await login(app, email, NEW_PASSWORD)).status).toBe(200);
  });

  test("400 on short/oversize/missing password, 404 unknown + anonymized, 401/403 without admin", async () => {
    const { db, app, adminCookie } = await makeAdmin();
    const email = `edge-${crypto.randomUUID()}@example.com`;
    const userCookie = await signUpAs(app, email);
    const uid = await uidByEmail(db, email);
    const url = `/api/v1/admin/users/${uid}/reset-password`;
    expect(
      (
        await req(app, url, {
          method: "POST",
          cookie: adminCookie,
          body: { newPassword: "short7" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req(app, url, {
          method: "POST",
          cookie: adminCookie,
          body: { newPassword: "x".repeat(201) },
        })
      ).status,
    ).toBe(400);
    expect((await req(app, url, { method: "POST", cookie: adminCookie, body: {} })).status).toBe(
      400,
    );
    expect(
      (await req(app, url, { method: "POST", cookie: adminCookie, raw: "not json" })).status,
    ).toBe(400);
    // Guard runs before any hashing: 401/403 without touching the account.
    expect(
      (await req(app, url, { method: "POST", body: { newPassword: NEW_PASSWORD } })).status,
    ).toBe(401);
    expect(
      (
        await req(app, url, {
          method: "POST",
          cookie: userCookie,
          body: { newPassword: NEW_PASSWORD },
        })
      ).status,
    ).toBe(403);
    const before = await q(db, "select password from account where user_id = ?", uid);
    expect(
      (
        await req(app, "/api/v1/admin/users/nope/reset-password", {
          method: "POST",
          cookie: adminCookie,
          body: { newPassword: NEW_PASSWORD },
        })
      ).status,
    ).toBe(404);
    const ghostId = crypto.randomUUID();
    await seedAnonymized(db, ghostId);
    expect(
      (
        await req(app, `/api/v1/admin/users/${ghostId}/reset-password`, {
          method: "POST",
          cookie: adminCookie,
          body: { newPassword: NEW_PASSWORD },
        })
      ).status,
    ).toBe(404);
    expect(await q(db, "select password from account where user_id = ?", uid)).toEqual(before);
  });

  test("audit insert failure rolls back the reset: credential, sessions, audit unchanged", async () => {
    const { db, app, adminCookie } = await makeAdmin();
    const email = `rbp-${crypto.randomUUID()}@example.com`;
    const targetCookie = await signUpAs(app, email);
    const uid = await uidByEmail(db, email);
    await withBlockedAudits(db, async () => {
      const res = await req(app, `/api/v1/admin/users/${uid}/reset-password`, {
        method: "POST",
        cookie: adminCookie,
        body: { newPassword: NEW_PASSWORD },
      });
      expect(res.status).toBe(500);
      // Old credential still works, target session survives, no audit row.
      expect((await login(app, email, PASSWORD)).status).toBe(200);
      expect((await getSession(app, targetCookie)).status).toBe(200);
      expect(
        await q(
          db,
          "select 1 from audit_log where target = ? and action = 'user.password_reset'",
          uid,
        ),
      ).toEqual([]);
    });
    // Trigger dropped: reset succeeds and takes effect.
    expect(
      (
        await req(app, `/api/v1/admin/users/${uid}/reset-password`, {
          method: "POST",
          cookie: adminCookie,
          body: { newPassword: NEW_PASSWORD },
        })
      ).status,
    ).toBe(200);
    expect((await login(app, email, NEW_PASSWORD)).status).toBe(200);
  });

  test("audit user.password_reset exists with no secrets anywhere", async () => {
    const { db, app, adminCookie } = await makeAdmin();
    const email = `audp-${crypto.randomUUID()}@example.com`;
    await signUpAs(app, email);
    const uid = await uidByEmail(db, email);
    await req(app, `/api/v1/admin/users/${uid}/reset-password`, {
      method: "POST",
      cookie: adminCookie,
      body: { newPassword: NEW_PASSWORD },
    });
    const rows = await q<{ action: string; detail: unknown }>(
      db,
      "select action, detail from audit_log where target = ? and action = 'user.password_reset'",
      uid,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.detail).toBe(null);
    // No hash/secret in any audit row for this target.
    const all = await q<Record<string, unknown>>(
      db,
      "select * from audit_log where target = ?",
      uid,
    );
    for (const row of all) {
      const raw = JSON.stringify(row);
      expect(raw).not.toContain(NEW_PASSWORD);
      expect(raw).not.toContain(PASSWORD);
    }
    // Reset response carries only the success flag.
    const res = await req(app, `/api/v1/admin/users/${uid}/reset-password`, {
      method: "POST",
      cookie: adminCookie,
      body: { newPassword: NEW_PASSWORD },
    });
    expect(JSON.stringify(await res.json())).not.toContain("password");
  });
});
