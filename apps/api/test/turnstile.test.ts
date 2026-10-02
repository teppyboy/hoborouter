// Task: Turnstile captcha plugin wiring in createAuth.
// With TURNSTILE_SECRET_KEY unset, auth behaves as before. With it set,
// sign-up/sign-in require a valid token verified against Cloudflare's
// siteverify endpoint (stubbed here — never called for real in tests).
import { afterEach, describe, expect, test } from "bun:test";
import { makeApp, req } from "./helpers";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SIGNUP = "/api/auth/sign-up/email";
const creds = { email: "t@example.com", password: "correct horse battery staple", name: "T" };

const realFetch = global.fetch;

describe("turnstile captcha", () => {
  afterEach(() => {
    delete process.env.TURNSTILE_SECRET_KEY;
    global.fetch = realFetch;
  });

  test("no secret key: sign-up works without a token", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const { app } = await makeApp();
    const res = await req(app, SIGNUP, { method: "POST", body: creds });
    expect(res.status).toBe(200);
  });

  test("secret key set + siteverify rejects → sign-up rejected", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    let called = 0;
    global.fetch = (async (input: string | URL | Request) => {
      if (String(input).startsWith(SITEVERIFY)) {
        called++;
        return new Response(JSON.stringify({ success: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input as Request);
    }) as typeof fetch;
    const { app } = await makeApp();
    const res = await req(app, SIGNUP, {
      method: "POST",
      headers: { "x-captcha-response": "tok" },
      body: creds,
    });
    expect(res.status).toBe(403);
    expect(called).toBe(1);
  });

  test("secret key set + siteverify accepts → sign-up accepted", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    global.fetch = (async (input: string | URL | Request) => {
      if (String(input).startsWith(SITEVERIFY)) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input as Request);
    }) as typeof fetch;
    const { app } = await makeApp();
    const res = await req(app, SIGNUP, {
      method: "POST",
      headers: { "x-captcha-response": "tok" },
      body: creds,
    });
    expect(res.status).toBe(200);
  });

  test("secret key set + missing token → 400", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    global.fetch = realFetch;
    const { app } = await makeApp();
    const res = await req(app, SIGNUP, { method: "POST", body: creds });
    expect(res.status).toBe(400);
  });
});
