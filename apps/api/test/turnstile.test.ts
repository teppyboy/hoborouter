// Task: Turnstile captcha plugin wiring in createAuth.
// With TURNSTILE_SECRET_KEY unset, auth behaves as before. With it set,
// sign-up/sign-in require a valid token verified against Cloudflare's
// siteverify endpoint (stubbed here — never called for real in tests).
import { describe, expect, test } from "bun:test";
import { makeApp, req } from "./helpers";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SIGNUP = "/api/auth/sign-up/email";
const SIGNIN = "/api/auth/sign-in/email";
const creds = { email: "t@example.com", password: "Correct-Horse-Battery-Staple-1", name: "T" };

const realFetch = global.fetch;

// Env is process-global: save + restore only the keys this file mutates, and
// always restore fetch, so no test leaves state behind (try/finally).
const withTurnstileEnv = async (run: () => Promise<void>) => {
  const savedKey = process.env.TURNSTILE_SECRET_KEY;
  try {
    await run();
  } finally {
    if (savedKey === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = savedKey;
    global.fetch = realFetch;
  }
};

// siteverify stub: never touches the network. accept=null leaves fetch
// untouched (no siteverify call expected). Non-siteverify requests are
// forwarded with both input AND init.
const stubSiteverify = (accept: boolean | null, onCall?: () => void) => {
  if (accept === null) return;
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith(SITEVERIFY)) {
      onCall?.();
      return new Response(JSON.stringify({ success: accept }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input as Request, init);
  }) as typeof fetch;
};

describe("turnstile captcha", () => {
  test("no secret key: sign-up works without a token", () =>
    withTurnstileEnv(async () => {
      delete process.env.TURNSTILE_SECRET_KEY;
      const { app } = await makeApp();
      const res = await req(app, SIGNUP, { method: "POST", body: creds });
      expect(res.status).toBe(200);
    }));

  test("secret key set + siteverify rejects → sign-up rejected", () =>
    withTurnstileEnv(async () => {
      process.env.TURNSTILE_SECRET_KEY = "test-secret";
      let called = 0;
      stubSiteverify(false, () => {
        called++;
      });
      const { app } = await makeApp();
      const res = await req(app, SIGNUP, {
        method: "POST",
        headers: { "x-captcha-response": "tok" },
        body: creds,
      });
      expect(res.status).toBe(403);
      expect(called).toBe(1);
    }));

  test("secret key set + siteverify accepts → sign-up accepted", () =>
    withTurnstileEnv(async () => {
      process.env.TURNSTILE_SECRET_KEY = "test-secret";
      stubSiteverify(true);
      const { app } = await makeApp();
      const res = await req(app, SIGNUP, {
        method: "POST",
        headers: { "x-captcha-response": "tok" },
        body: creds,
      });
      expect(res.status).toBe(200);
    }));

  test("secret key set + missing token → 400 (no siteverify call)", () =>
    withTurnstileEnv(async () => {
      process.env.TURNSTILE_SECRET_KEY = "test-secret";
      stubSiteverify(null);
      const { app } = await makeApp();
      const res = await req(app, SIGNUP, { method: "POST", body: creds });
      expect(res.status).toBe(400);
    }));

  test("secret key set + sign-in with valid token → accepted", () =>
    withTurnstileEnv(async () => {
      process.env.TURNSTILE_SECRET_KEY = "test-secret";
      stubSiteverify(true);
      const { app } = await makeApp();
      const signup = await req(app, SIGNUP, {
        method: "POST",
        headers: { "x-captcha-response": "tok" },
        body: creds,
      });
      expect(signup.status).toBe(200);
      const res = await req(app, SIGNIN, {
        method: "POST",
        headers: { "x-captcha-response": "tok" },
        body: { email: creds.email, password: creds.password },
      });
      expect(res.status).toBe(200);
    }));

  test("secret key set + sign-in without token → 400", () =>
    withTurnstileEnv(async () => {
      process.env.TURNSTILE_SECRET_KEY = "test-secret";
      stubSiteverify(null);
      const { app } = await makeApp();
      const res = await req(app, SIGNIN, {
        method: "POST",
        body: { email: creds.email, password: creds.password },
      });
      expect(res.status).toBe(400);
    }));
});
