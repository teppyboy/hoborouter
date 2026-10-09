// GET /api/v1/public-config: unauthenticated public flags for the SPA.
// Turnstile site key is exposed ONLY when TURNSTILE_SECRET_KEY is set (captcha
// enforced); secret set without a site key fails closed with a safe 503.
// The secret key itself must never appear in the response.
import { afterEach, describe, expect, test } from "bun:test";
import { makeApp, req } from "./helpers";

// TURNSTILE_* env is process-global: pin a deterministic state before each
// test and restore whatever the original values were after each test.
const KEYS = [
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_SITE_KEY",
  "VITE_TURNSTILE_SITE_KEY",
  "HBR_OAUTH_GOOGLE_CLIENT_ID",
  "HBR_OAUTH_GOOGLE_CLIENT_SECRET",
  "HBR_OAUTH_DISCORD_CLIENT_ID",
  "HBR_OAUTH_DISCORD_CLIENT_SECRET",
  "HBR_OAUTH_GITHUB_CLIENT_ID",
  "HBR_OAUTH_GITHUB_CLIENT_SECRET",
] as const;
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const k of KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

const pinEnv = (values: Partial<Record<(typeof KEYS)[number], string | undefined>>) => {
  for (const k of KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
  for (const k of KEYS) {
    const v = values[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

describe("public-config", () => {
  test("no secret key: site key is null even when one is set", async () => {
    pinEnv({ TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: "site-123" });
    const { app } = await makeApp();
    const res = await req(app, "/api/v1/public-config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      turnstileSiteKey: null,
      emailVerification: { enabled: false, required: false },
      socialProviders: { google: false, discord: false, github: false },
    });
  });

  test("no env at all: null site key, email verification off", async () => {
    pinEnv({
      TURNSTILE_SECRET_KEY: undefined,
      TURNSTILE_SITE_KEY: undefined,
      VITE_TURNSTILE_SITE_KEY: undefined,
    });
    const { app } = await makeApp();
    const res = await req(app, "/api/v1/public-config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      turnstileSiteKey: null,
      emailVerification: { enabled: false, required: false },
      socialProviders: { google: false, discord: false, github: false },
    });
  });

  test("secret + TURNSTILE_SITE_KEY: site key exposed, secret never", async () => {
    pinEnv({ TURNSTILE_SECRET_KEY: "super-secret", TURNSTILE_SITE_KEY: "site-123" });
    const { app } = await makeApp();
    const res = await req(app, "/api/v1/public-config");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("super-secret");
    expect(JSON.parse(raw).turnstileSiteKey).toBe("site-123");
  });

  test("secret + legacy VITE_TURNSTILE_SITE_KEY fallback", async () => {
    pinEnv({
      TURNSTILE_SECRET_KEY: "super-secret",
      TURNSTILE_SITE_KEY: undefined,
      VITE_TURNSTILE_SITE_KEY: "legacy-site",
    });
    const { app } = await makeApp();
    const res = await req(app, "/api/v1/public-config");
    expect(res.status).toBe(200);
    expect((await res.json()).turnstileSiteKey).toBe("legacy-site");
  });

  test("secret set + site key missing → fail closed 503, no secret leak", async () => {
    pinEnv({ TURNSTILE_SECRET_KEY: "super-secret" });
    const { app } = await makeApp();
    const res = await req(app, "/api/v1/public-config");
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect(raw).not.toContain("super-secret");
    const body = JSON.parse(raw);
    expect(body.error.code).toBe("CONFIGURATION_ERROR");
  });

  test("secret set + blank site key → fail closed 503", async () => {
    pinEnv({ TURNSTILE_SECRET_KEY: "super-secret", TURNSTILE_SITE_KEY: "   " });
    const { app } = await makeApp();
    const res = await req(app, "/api/v1/public-config");
    expect(res.status).toBe(503);
  });

  test("no OAuth env: all social provider flags false", async () => {
    pinEnv({});
    const { app } = await makeApp();
    const res = await req(app, "/api/v1/public-config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.socialProviders).toEqual({ google: false, discord: false, github: false });
  });

  test("complete provider pair: only that provider advertised", async () => {
    pinEnv({
      HBR_OAUTH_GITHUB_CLIENT_ID: "gh-id",
      HBR_OAUTH_GITHUB_CLIENT_SECRET: "gh-secret-value",
    });
    const { app } = await makeApp();
    const res = await req(app, "/api/v1/public-config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.socialProviders).toEqual({ google: false, discord: false, github: true });
  });

  test("partial provider config (id only): flag stays false", async () => {
    pinEnv({ HBR_OAUTH_GOOGLE_CLIENT_ID: "g-id" });
    const { app } = await makeApp();
    const res = await req(app, "/api/v1/public-config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.socialProviders).toEqual({ google: false, discord: false, github: false });
  });

  test("OAuth secrets never appear in the public-config response", async () => {
    pinEnv({
      HBR_OAUTH_GITHUB_CLIENT_ID: "gh-id",
      HBR_OAUTH_GITHUB_CLIENT_SECRET: "gh-secret-value",
    });
    const { app } = await makeApp();
    const res = await req(app, "/api/v1/public-config");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("gh-secret-value");
  });
});
