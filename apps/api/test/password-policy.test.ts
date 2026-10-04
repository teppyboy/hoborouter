// Password policy enforcement (server-side, red/green):
// - /api/auth/sign-up/email and /api/auth/change-password reject weak passwords
//   with 400 + a readable message (auth.ts hooks.before).
// - Admin create (/api/v1/admin/users) and reset-password reject weak too.
// Sign-in is never re-checked: existing passwords keep working.
import { beforeAll, describe, expect, test } from "bun:test";
import { makeApp, makeInstanceAdmin, req, signUp, userIdByEmail } from "./helpers";

// Compliant per packages/shared PASSWORD_RULES (8..200, lower, upper, digit, special).
const GOOD = "Correct-Horse-Battery-Staple-1";
// Violates: no uppercase, no digit, no special.
const WEAK = "correct horse battery staple";

let ctx: Awaited<ReturnType<typeof makeApp>>;

beforeAll(async () => {
  ctx = await makeApp();
});

describe("POST /api/auth/sign-up/email password policy", () => {
  test("weak password rejected with 400 and readable message", async () => {
    const res = await req(ctx.app, "/api/auth/sign-up/email", {
      method: "POST",
      body: { email: "weak@example.com", password: WEAK, name: "W" },
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Password does not meet the requirements");
  });

  test("compliant password accepted", async () => {
    const res = await req(ctx.app, "/api/auth/sign-up/email", {
      method: "POST",
      body: { email: "strong@example.com", password: GOOD, name: "S" },
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/auth/change-password password policy", () => {
  test("weak newPassword rejected with 400; password unchanged", async () => {
    const cookie = await signUp(ctx.app, "changer@example.com", "C");
    const res = await req(ctx.app, "/api/auth/change-password", {
      method: "POST",
      cookie,
      body: { currentPassword: GOOD, newPassword: WEAK, revokeOtherSessions: true },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Password does not meet the requirements");
    // Old credential still signs in: the weak password was never stored.
    const stillOld = await req(ctx.app, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email: "changer@example.com", password: GOOD },
    });
    expect(stillOld.status).toBe(200);
  });
});

describe("admin create + reset password policy", () => {
  test("admin create weak password rejected 400", async () => {
    const adminCookie = await signUp(ctx.app, "create-admin@example.com", "A");
    await makeInstanceAdmin(ctx.db, await userIdByEmail(ctx.db, "create-admin@example.com"));
    const res = await req(ctx.app, "/api/v1/admin/users", {
      method: "POST",
      cookie: adminCookie,
      body: { name: "New", email: "new-weak@example.com", password: WEAK },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Password does not meet the requirements");
  });

  test("admin reset-password weak rejected 400", async () => {
    const adminCookie = await signUp(ctx.app, "reset-admin@example.com", "A");
    await makeInstanceAdmin(ctx.db, await userIdByEmail(ctx.db, "reset-admin@example.com"));
    const targetCookie = await signUp(ctx.app, "target@example.com", "T");
    void targetCookie;
    const targetId = await userIdByEmail(ctx.db, "target@example.com");
    const res = await req(ctx.app, `/api/v1/admin/users/${targetId}/reset-password`, {
      method: "POST",
      cookie: adminCookie,
      body: { newPassword: WEAK },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Password does not meet the requirements");
    // Target's original credential still valid.
    expect(
      (
        await req(ctx.app, "/api/auth/sign-in/email", {
          method: "POST",
          body: { email: "target@example.com", password: GOOD },
        })
      ).status,
    ).toBe(200);
  });
});
