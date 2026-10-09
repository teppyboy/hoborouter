// Implicit account-linking policy (Better Auth 1.7.6 defaults, audited):
// linking on OAuth sign-in happens ONLY when the provider email is verified
// AND the existing local user row is email-verified. No accountLinking
// overrides are configured anywhere (allowDifferentEmails stays false,
// trustedProviders stays empty), so a different email can never link into an
// existing account and an unverified local row is never taken over.
// GitHub endpoints are stubbed at the fetch layer (see turnstile.test.ts
// pattern); the real Better Auth callback code runs end to end.
import { afterEach, describe, expect, test } from "bun:test";
import { cookieOf, makeApp, q, req, signUp } from "./helpers";

const realFetch = global.fetch;

const OAUTH_KEYS = [
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "HBR_OAUTH_GITHUB_CLIENT_ID",
  "HBR_OAUTH_GITHUB_CLIENT_SECRET",
] as const;

afterEach(() => {
  global.fetch = realFetch;
  for (const k of OAUTH_KEYS) delete process.env[k];
});

const stubGitHub = (opts: { email: string; verified: boolean }) => {
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return new Response(
        JSON.stringify({ access_token: "gho_test-token", token_type: "bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/user") {
      return new Response(
        JSON.stringify({ id: 4242, login: "ghuser", name: "GH User", email: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/user/emails") {
      return new Response(
        JSON.stringify([{ email: opts.email, primary: true, verified: opts.verified }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return realFetch(input as Request, init);
  }) as typeof fetch;
};

const setup = async () => {
  process.env.BETTER_AUTH_URL = "http://localhost:5199";
  process.env.BETTER_AUTH_SECRET = "x".repeat(32);
  process.env.HBR_OAUTH_GITHUB_CLIENT_ID = "gh-id";
  process.env.HBR_OAUTH_GITHUB_CLIENT_SECRET = "gh-secret";
  return makeApp();
};

const oauthSignIn = async (
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  opts: { email: string; verified: boolean },
) => {
  stubGitHub(opts);
  const init = await req(app, "/api/auth/sign-in/social", {
    method: "POST",
    body: { provider: "github", callbackURL: "/" },
  });
  expect(init.status).toBe(200);
  const { url } = (await init.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  expect(state).toBeTruthy();
  return req(app, `/api/auth/callback/github?code=auth-code&state=${encodeURIComponent(state!)}`, {
    cookie: cookieOf(init),
  });
};

const userCount = async (db: Awaited<ReturnType<typeof makeApp>>["db"]) =>
  ((await q(db, "SELECT COUNT(*)::int AS n FROM users"))[0]?.n as number) ?? 0;

describe("implicit OAuth account linking (defaults, no overrides)", () => {
  test("verified provider email + verified local user → links into the existing account", async () => {
    const { db, app } = await setup();
    await signUp(app, "linked@e2e.test");
    // Email verification is optional in this app, so verify the local row the
    // way a verified user would end up (setup only; authz flows stay HTTP).
    await q(db, "UPDATE users SET email_verified = true WHERE email = 'linked@e2e.test'");
    const before = await userCount(db);
    const res = await oauthSignIn(app, { email: "linked@e2e.test", verified: true });
    expect(res.status).toBe(302);
    expect(
      new URL(res.headers.get("location")!, "http://localhost:5199").searchParams.has("error"),
    ).toBe(false);
    expect(await userCount(db)).toBe(before);
    const accounts = await q(
      db,
      "SELECT provider_id FROM account a JOIN users u ON u.id = a.user_id WHERE u.email = 'linked@e2e.test'",
    );
    expect(accounts.map((r) => r.provider_id)).toContain("github");
    expect(cookieOf(res)).toContain("better-auth.session_token=");
  });

  test("verified provider email + UNVERIFIED local user → no link, no new user, error redirect", async () => {
    const { db, app } = await setup();
    await signUp(app, "unverified@e2e.test"); // emailVerified stays false
    const before = await userCount(db);
    const res = await oauthSignIn(app, { email: "unverified@e2e.test", verified: true });
    expect(res.status).toBe(302);
    expect(
      new URL(res.headers.get("location")!, "http://localhost:5199").searchParams.get("error"),
    ).toBe("account_not_linked");
    expect(await userCount(db)).toBe(before);
    expect(cookieOf(res)).not.toContain("better-auth.session_token=");
  });

  test("unverified provider email can never link a verified local account", async () => {
    const { db, app } = await setup();
    await signUp(app, "victim@e2e.test");
    await q(db, "UPDATE users SET email_verified = true WHERE email = 'victim@e2e.test'");
    const before = await userCount(db);
    const res = await oauthSignIn(app, { email: "victim@e2e.test", verified: false });
    expect(res.status).toBe(302);
    expect(
      new URL(res.headers.get("location")!, "http://localhost:5199").searchParams.get("error"),
    ).toBe("account_not_linked");
    expect(await userCount(db)).toBe(before);
  });

  test("different provider email → separate user; existing account untouched", async () => {
    const { db, app } = await setup();
    await signUp(app, "existing@e2e.test");
    const before = await userCount(db);
    const res = await oauthSignIn(app, { email: "other@e2e.test", verified: true });
    expect(res.status).toBe(302);
    expect(await userCount(db)).toBe(before + 1);
    const linked = await q(
      db,
      "SELECT COUNT(*)::int AS n FROM account a JOIN users u ON u.id = a.user_id WHERE u.email = 'existing@e2e.test' AND a.provider_id = 'github'",
    );
    expect((linked[0]?.n as number) ?? 0).toBe(0);
  });
});
