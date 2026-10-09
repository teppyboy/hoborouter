// OAuth signup vs the production instance-admin bootstrap gate.
// An UNVERIFIED provider email must NEVER grant instance admin (no email-only
// takeover through a spoofed provider identity); a VERIFIED provider email
// keeps the existing zero-admin bootstrap rule. The password-signup bootstrap
// path is unchanged and stays covered by bootstrap-admin.test.ts.
//
// The GitHub OAuth endpoints are stubbed at the fetch layer (same pattern as
// turnstile.test.ts): the REAL Better Auth initiation + callback code runs
// end-to-end against this fake — no live provider, no real credentials.
import { afterEach, describe, expect, test } from "bun:test";
import type { Db } from "@hoborouter/db";
import { cookieOf, makeApp, q, req } from "./helpers";

const realFetch = global.fetch;

const OAUTH_KEYS = [
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL",
  "HBR_OAUTH_GITHUB_CLIENT_ID",
  "HBR_OAUTH_GITHUB_CLIENT_SECRET",
] as const;

afterEach(() => {
  global.fetch = realFetch;
  for (const k of OAUTH_KEYS) delete process.env[k];
});

const stubGitHub = (verified: boolean) => {
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return new Response(
        JSON.stringify({
          access_token: "gho_test-token",
          token_type: "bearer",
          scope: "read:user,user:email",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/user") {
      return new Response(
        JSON.stringify({
          id: 4242,
          login: "ghuser",
          name: "GH User",
          avatar_url: "https://avatars.example/gh.png",
          email: null, // private email: resolved via /user/emails (built-in behavior)
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/user/emails") {
      return new Response(JSON.stringify([{ email: "admin@e2e.test", primary: true, verified }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input as Request, init);
  }) as typeof fetch;
};

const setup = async () => {
  process.env.BETTER_AUTH_URL = "http://localhost:5199";
  process.env.BETTER_AUTH_SECRET = "x".repeat(32);
  process.env.HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL = "admin@e2e.test";
  process.env.HBR_OAUTH_GITHUB_CLIENT_ID = "gh-id";
  process.env.HBR_OAUTH_GITHUB_CLIENT_SECRET = "gh-secret";
  return makeApp();
};

/** Real initiation + fake callback; returns the callback response. */
const oauthSignUp = async (app: Awaited<ReturnType<typeof makeApp>>["app"], verified: boolean) => {
  stubGitHub(verified);
  const init = await req(app, "/api/auth/sign-in/social", {
    method: "POST",
    body: { provider: "github", callbackURL: "/" },
  });
  expect(init.status).toBe(200);
  const { url } = (await init.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  expect(state).toBeTruthy();
  const cookie = cookieOf(init);
  expect(cookie).toContain("state=");
  return req(app, `/api/auth/callback/github?code=auth-code&state=${encodeURIComponent(state!)}`, {
    cookie,
  });
};

const adminCount = async (db: Db) => {
  const rows = await q(db, "SELECT COUNT(*)::int AS n FROM instance_admins");
  return (rows[0]?.n as number | undefined) ?? 0;
};

describe("OAuth signup and the dev/test admin convenience grant", () => {
  const devSetup = async () => {
    process.env.NODE_ENV = "test";
    process.env.BETTER_AUTH_URL = "http://localhost:5199";
    process.env.BETTER_AUTH_SECRET = "x".repeat(32);
    process.env.HBR_DEV_ADMIN_EMAIL = "admin@e2e.test";
    process.env.HBR_OAUTH_GITHUB_CLIENT_ID = "gh-id";
    process.env.HBR_OAUTH_GITHUB_CLIENT_SECRET = "gh-secret";
    return makeApp();
  };

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  test("UNVERIFIED provider email matching HBR_DEV_ADMIN_EMAIL grants NO admin (same gate as production bootstrap)", async () => {
    const { db, app } = await devSetup();
    const res = await oauthSignUp(app, false);
    expect(res.status).toBe(302);
    const rows = await q(db, "SELECT COUNT(*)::int AS n FROM users");
    expect(rows[0]?.n).toBe(1);
    expect(await adminCount(db)).toBe(0);
  });

  test("VERIFIED provider email matching HBR_DEV_ADMIN_EMAIL keeps the dev grant", async () => {
    const { db, app } = await devSetup();
    const res = await oauthSignUp(app, true);
    expect(res.status).toBe(302);
    expect(await adminCount(db)).toBe(1);
  });
});

describe("OAuth signup and the instance-admin bootstrap gate", () => {
  test("VERIFIED provider email matching the bootstrap email grants admin (zero-admin rule)", async () => {
    const { db, app } = await setup();
    const res = await oauthSignUp(app, true);
    expect(res.status).toBe(302);
    const rows = await q(db, "SELECT COUNT(*)::int AS n FROM users");
    expect(rows[0]?.n).toBe(1);
    expect(await adminCount(db)).toBe(1);
  });

  test("UNVERIFIED provider email matching the bootstrap email grants NO admin", async () => {
    const { db, app } = await setup();
    const res = await oauthSignUp(app, false);
    expect(res.status).toBe(302);
    // The user is still created and session-issued like any OAuth signup —
    // only the privilege is withheld.
    const rows = await q(db, "SELECT COUNT(*)::int AS n FROM users");
    expect(rows[0]?.n).toBe(1);
    expect(await adminCount(db)).toBe(0);
  });

  test("OAuth user session works; admin flag comes only from the bootstrap rule", async () => {
    const { db, app } = await setup();
    const res = await oauthSignUp(app, false);
    expect(res.status).toBe(302);
    const session = await q(
      db,
      "SELECT COUNT(*)::int AS n FROM session s JOIN users u ON u.id = s.user_id WHERE u.email = 'admin@e2e.test'",
    );
    expect(session[0]?.n).toBe(1);
    const account = await q(
      db,
      "SELECT provider_id, account_id FROM account WHERE provider_id = 'github'",
    );
    expect(account.length).toBe(1);
    expect(await adminCount(db)).toBe(0);
  });
});
