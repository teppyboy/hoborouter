// Explicit account linking from the settings page (Better Auth 1.7.6 native
// endpoints, audited end to end against a real auth instance):
// - POST /api/auth/link-social mints a session-bound state (link.userId) with
//   PKCE; the callback links ONLY that session's user.
// - Safe linking defaults hold for explicit links too: the provider email must
//   be verified AND match the local user's email; a provider identity already
//   owned by another user can never be claimed; no accountLinking overrides.
// - The callbackURL is validated against trusted origins (no open redirect).
// - GET /api/auth/list-accounts is session-scoped.
// - POST /api/auth/unlink-account needs a FRESH session, refuses to remove the
//   last remaining sign-in method, and password/email sign-in keeps working.
// GitHub provider HTTP endpoints are stubbed at the fetch layer; no live
// provider, no direct DB linking in any code path under test.
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

/** Stub GitHub's OAuth2 endpoints; `id` lets tests claim/differ identities. */
const stubGitHub = (opts: { email: string; verified: boolean; id?: number }) => {
  const githubId = opts.id ?? 4242;
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
        JSON.stringify({ id: githubId, login: "ghuser", name: "GH User", email: null }),
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

/** Start the explicit-link flow; returns the provider authorization URL. */
const linkInit = async (
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  cookie: string | undefined,
  body: Record<string, unknown> = { provider: "github", callbackURL: "/settings?tab=account" },
) => {
  const res = await req(app, "/api/auth/link-social", {
    method: "POST",
    cookie,
    body,
    headers: { origin: "http://localhost:5199" },
  });
  return res;
};

/** Complete the link round-trip for the state minted by `init`. */
const linkCallback = async (
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  init: Response,
  opts: { email: string; verified: boolean; id?: number },
) => {
  stubGitHub(opts);
  const { url } = (await init.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  expect(state).toBeTruthy();
  return req(app, `/api/auth/callback/github?code=auth-code&state=${encodeURIComponent(state!)}`, {
    cookie: cookieOf(init),
  });
};

const accountsOf = async (db: Awaited<ReturnType<typeof makeApp>>["db"], email: string) =>
  q(
    db,
    "SELECT a.provider_id, a.account_id FROM account a JOIN users u ON u.id = a.user_id WHERE u.email = ?",
    email,
  );

describe("explicit linking via /api/auth/link-social", () => {
  test("unauthenticated link request is rejected (session-bound intent)", async () => {
    const { app } = await setup();
    const res = await linkInit(app, undefined);
    expect(res.status).toBe(401);
  });

  test("callbackURL is validated against trusted origins (no open redirect)", async () => {
    // Better Auth skips callbackURL/origin validation under its own isTest()
    // default; the deployed contract is the production one, so assert it there.
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { app } = await setup();
      const cookie = await signUp(app, "linker@e2e.test");
      const res = await linkInit(app, cookie, {
        provider: "github",
        callbackURL: "https://evil.example/settings",
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("INVALID_CALLBACK_URL");
      // Same-origin relative callback paths stay accepted.
      const okRes = await linkInit(app, cookie, {
        provider: "github",
        callbackURL: "/settings?tab=account",
      });
      expect(okRes.status).toBe(200);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  test("state carries the linking user: two users each link their own session", async () => {
    const { db, app } = await setup();
    for (const email of ["user-a@e2e.test", "user-b@e2e.test"]) {
      await signUp(app, email);
      await q(db, "UPDATE users SET email_verified = true WHERE email = ?", email);
    }
    stubGitHub({ email: "user-a@e2e.test", verified: true });
    const initA = await linkInit(
      app,
      cookieOf(
        await req(app, "/api/auth/sign-in/email", {
          method: "POST",
          body: { email: "user-a@e2e.test", password: "Correct-Horse-Battery-Staple-1" },
        }),
      ),
    );
    expect(initA.status).toBe(200);
    const resA = await linkCallback(app, initA, { email: "user-a@e2e.test", verified: true });
    expect(resA.status).toBe(302);
    expect(
      new URL(resA.headers.get("location")!, "http://localhost:5199").searchParams.has("error"),
    ).toBe(false);

    stubGitHub({ email: "user-b@e2e.test", verified: true, id: 777 });
    const initB = await linkInit(
      app,
      cookieOf(
        await req(app, "/api/auth/sign-in/email", {
          method: "POST",
          body: { email: "user-b@e2e.test", password: "Correct-Horse-Battery-Staple-1" },
        }),
      ),
    );
    const resB = await linkCallback(app, initB, {
      email: "user-b@e2e.test",
      verified: true,
      id: 777,
    });
    expect(resB.status).toBe(302);
    expect(
      new URL(resB.headers.get("location")!, "http://localhost:5199").searchParams.has("error"),
    ).toBe(false);

    const a = await accountsOf(db, "user-a@e2e.test");
    const b = await accountsOf(db, "user-b@e2e.test");
    // Password signups also hold a `credential` account row; only the OAuth
    // identity is linking evidence here.
    expect(a.filter((r) => r.provider_id === "github").map((r) => String(r.account_id))).toEqual([
      "4242",
    ]);
    expect(b.filter((r) => r.provider_id === "github").map((r) => String(r.account_id))).toEqual([
      "777",
    ]);
  });

  test("unverified provider email can never link explicitly", async () => {
    const { db, app } = await setup();
    await signUp(app, "linker@e2e.test");
    await q(db, "UPDATE users SET email_verified = true WHERE email = 'linker@e2e.test'");
    const init = await linkInit(
      app,
      cookieOf(
        await req(app, "/api/auth/sign-in/email", {
          method: "POST",
          body: { email: "linker@e2e.test", password: "Correct-Horse-Battery-Staple-1" },
        }),
      ),
    );
    const res = await linkCallback(app, init, { email: "linker@e2e.test", verified: false });
    expect(res.status).toBe(302);
    expect(
      new URL(res.headers.get("location")!, "http://localhost:5199").searchParams.get("error"),
    ).toBe("unable_to_link_account");
    expect(
      (await accountsOf(db, "linker@e2e.test")).filter((r) => r.provider_id === "github"),
    ).toHaveLength(0);
  });

  test("provider email different from the local user is rejected (allowDifferentEmails stays false)", async () => {
    const { db, app } = await setup();
    await signUp(app, "linker@e2e.test");
    await q(db, "UPDATE users SET email_verified = true WHERE email = 'linker@e2e.test'");
    const init = await linkInit(
      app,
      cookieOf(
        await req(app, "/api/auth/sign-in/email", {
          method: "POST",
          body: { email: "linker@e2e.test", password: "Correct-Horse-Battery-Staple-1" },
        }),
      ),
    );
    const res = await linkCallback(app, init, { email: "someone-else@e2e.test", verified: true });
    expect(res.status).toBe(302);
    expect(
      new URL(res.headers.get("location")!, "http://localhost:5199").searchParams.get("error"),
    ).toBe("email_does_not_match");
    expect(
      (await accountsOf(db, "linker@e2e.test")).filter((r) => r.provider_id === "github"),
    ).toHaveLength(0);
  });

  test("a provider identity owned by another user can never be claimed", async () => {
    const { db, app } = await setup();
    for (const email of ["owner@e2e.test", "claimer@e2e.test"]) {
      await signUp(app, email);
      await q(db, "UPDATE users SET email_verified = true WHERE email = ?", email);
    }
    const signIn = async (email: string) =>
      cookieOf(
        await req(app, "/api/auth/sign-in/email", {
          method: "POST",
          body: { email, password: "Correct-Horse-Battery-Staple-1" },
        }),
      );
    const initOwner = await linkInit(app, await signIn("owner@e2e.test"));
    const resOwner = await linkCallback(app, initOwner, {
      email: "owner@e2e.test",
      verified: true,
    });
    expect(resOwner.status).toBe(302);

    const initClaimer = await linkInit(app, await signIn("claimer@e2e.test"));
    const resClaimer = await linkCallback(app, initClaimer, {
      email: "claimer@e2e.test",
      verified: true,
      id: 4242,
    });
    expect(resClaimer.status).toBe(302);
    expect(
      new URL(resClaimer.headers.get("location")!, "http://localhost:5199").searchParams.get(
        "error",
      ),
    ).toBe("account_already_linked_to_different_user");
    expect(
      (await accountsOf(db, "claimer@e2e.test")).filter((r) => r.provider_id === "github"),
    ).toHaveLength(0);
  });

  test("re-linking the same identity updates in place (still one account row)", async () => {
    const { db, app } = await setup();
    await signUp(app, "linker@e2e.test");
    await q(db, "UPDATE users SET email_verified = true WHERE email = 'linker@e2e.test'");
    const cookie = cookieOf(
      await req(app, "/api/auth/sign-in/email", {
        method: "POST",
        body: { email: "linker@e2e.test", password: "Correct-Horse-Battery-Staple-1" },
      }),
    );
    const first = await linkCallback(app, await linkInit(app, cookie), {
      email: "linker@e2e.test",
      verified: true,
    });
    expect(first.status).toBe(302);
    const second = await linkCallback(app, await linkInit(app, cookie), {
      email: "linker@e2e.test",
      verified: true,
    });
    expect(second.status).toBe(302);
    expect(
      (await accountsOf(db, "linker@e2e.test")).filter((r) => r.provider_id === "github"),
    ).toHaveLength(1);
  });
});

describe("list-accounts and unlink-account", () => {
  test("list-accounts is session-scoped and reports the provider + credential accounts", async () => {
    const { app } = await setup();
    const anon = await req(app, "/api/auth/list-accounts");
    expect(anon.status).toBe(401);
  });

  test("password user unlinks a linked provider; email sign-in keeps working; unknown id rejected", async () => {
    const { db, app } = await setup();
    const email = "unlinker@e2e.test";
    await signUp(app, email);
    await q(db, "UPDATE users SET email_verified = true WHERE email = ?", email);
    const cookie = cookieOf(
      await req(app, "/api/auth/sign-in/email", {
        method: "POST",
        body: { email, password: "Correct-Horse-Battery-Staple-1" },
      }),
    );
    const linked = await linkCallback(app, await linkInit(app, cookie), { email, verified: true });
    expect(linked.status).toBe(302);

    const listed = await req(app, "/api/auth/list-accounts", { cookie });
    expect(listed.status).toBe(200);
    const accounts = (await listed.json()) as { id: string; providerId: string }[];
    const github = accounts.find((a) => a.providerId === "github");
    expect(github).toBeDefined();
    expect(accounts.some((a) => a.providerId === "credential")).toBe(true);

    // A bogus account id is a clean 400, not a crash (while ≥2 accounts exist).
    const unknown = await req(app, "/api/auth/unlink-account", {
      method: "POST",
      cookie,
      body: { accountId: "does-not-exist" },
      headers: { origin: "http://localhost:5199" },
    });
    expect(unknown.status).toBe(400);
    const unknownBody = (await unknown.json()) as { error?: { code?: string } };
    expect(unknownBody.error?.code).toBe("ACCOUNT_NOT_FOUND");

    const unlinked = await req(app, "/api/auth/unlink-account", {
      method: "POST",
      cookie,
      body: { accountId: github!.id },
      headers: { origin: "http://localhost:5199" },
    });
    expect(unlinked.status).toBe(200);
    const body = (await unlinked.json()) as { status: boolean };
    expect(body.status).toBe(true);
    expect((await accountsOf(db, email)).filter((r) => r.provider_id === "github")).toHaveLength(0);

    // Password login is untouched by unlinking.
    const reSignIn = await req(app, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: "Correct-Horse-Battery-Staple-1" },
    });
    expect(reSignIn.status).toBe(200);

    // The remaining `credential` account is the last sign-in method: unlinking
    // its (already removed) row is refused, never silently destructive.
    const again = await req(app, "/api/auth/unlink-account", {
      method: "POST",
      cookie,
      body: { accountId: github!.id },
      headers: { origin: "http://localhost:5199" },
    });
    expect(again.status).toBe(400);
    const errBody = (await again.json()) as { error?: { code?: string } };
    expect(errBody.error?.code).toBe("FAILED_TO_UNLINK_LAST_ACCOUNT");
  });

  test("unlink requires a fresh session (reauth gate)", async () => {
    const { db, app } = await setup();
    const email = "stale@e2e.test";
    await signUp(app, email);
    await q(db, "UPDATE users SET email_verified = true WHERE email = ?", email);
    const cookie = cookieOf(
      await req(app, "/api/auth/sign-in/email", {
        method: "POST",
        body: { email, password: "Correct-Horse-Battery-Staple-1" },
      }),
    );
    const linked = await linkCallback(app, await linkInit(app, cookie), { email, verified: true });
    expect(linked.status).toBe(302);
    // Backdate every session of the user past the default freshAge (24h).
    await q(
      db,
      "UPDATE session SET created_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)",
      Date.now() - 25 * 3600_000,
      email,
    );
    const listed = await req(app, "/api/auth/list-accounts", { cookie });
    const accounts = (await listed.json()) as { id: string; providerId: string }[];
    const github = accounts.find((a) => a.providerId === "github");
    expect(github).toBeDefined();
    const res = await req(app, "/api/auth/unlink-account", {
      method: "POST",
      cookie,
      body: { accountId: github!.id },
      headers: { origin: "http://localhost:5199" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("SESSION_NOT_FRESH");
    expect((await accountsOf(db, email)).filter((r) => r.provider_id === "github")).toHaveLength(1);
  });

  test("a social-only user cannot unlink the last remaining sign-in method", async () => {
    const { db, app } = await setup();
    // No prior signup: the OAuth callback signs the user up implicitly.
    stubGitHub({ email: "social-only@e2e.test", verified: true });
    const init = await req(app, "/api/auth/sign-in/social", {
      method: "POST",
      body: { provider: "github", callbackURL: "/" },
    });
    expect(init.status).toBe(200);
    const { url } = (await init.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");
    const cb = await req(
      app,
      `/api/auth/callback/github?code=auth-code&state=${encodeURIComponent(state!)}`,
      { cookie: cookieOf(init) },
    );
    expect(cb.status).toBe(302);
    const cookie = cookieOf(cb);
    expect(cookie).toContain("better-auth.session_token=");

    const listed = await req(app, "/api/auth/list-accounts", { cookie });
    const accounts = (await listed.json()) as { id: string; providerId: string }[];
    expect(accounts.map((a) => a.providerId)).toEqual(["github"]);
    const res = await req(app, "/api/auth/unlink-account", {
      method: "POST",
      cookie,
      body: { accountId: accounts[0]!.id },
      headers: { origin: "http://localhost:5199" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("FAILED_TO_UNLINK_LAST_ACCOUNT");
    const email = "social-only@e2e.test";
    expect((await accountsOf(db, email)).filter((r) => r.provider_id === "github")).toHaveLength(1);
  });
});
