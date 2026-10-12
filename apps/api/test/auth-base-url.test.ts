// Canonical auth base URL: the single origin Better Auth uses to derive every
// provider callback (redirect_uri). Providers compare redirect_uri as an exact
// string, so trailing slashes, path suffixes, and port changes must either
// normalize deterministically or fail at startup — never reach the portal as a
// mismatched URI.
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config/loader";
import { createAuth, canonicalAuthBaseURL } from "../src/auth";
import { createDb } from "@hoborouter/db";

// Lazy connection: createAuth only builds the Better Auth context here and
// never queries, so no live Postgres is needed for derivation tests.
const db = createDb("postgres://hoborouter:unused@127.0.0.1:55432/none");

const callbackFor = (baseURL: string, provider: "discord" | "github"): string =>
  `${baseURL}/api/auth/callback/${provider}`;

/** Better Auth context base URL for a configured base (the sign-in route
 *  builds redirect_uri as `${ctx.baseURL}/callback/<provider>`). */
const ctxBaseURL = async (baseURL: string): Promise<string> => {
  const cfg = await loadConfig({
    env: { BETTER_AUTH_URL: baseURL, DATABASE_URL: "postgres://u:p@127.0.0.1:55432/none" },
  });
  const auth = createAuth(db, cfg);
  const ctx = await auth.$context;
  return ctx.baseURL;
};

describe("canonicalAuthBaseURL", () => {
  test("trailing slash is stripped: same origin as the bare host", () => {
    expect(canonicalAuthBaseURL({ BETTER_AUTH_URL: "https://hbr.example.me/" })).toBe(
      "https://hbr.example.me",
    );
    expect(canonicalAuthBaseURL({ BETTER_AUTH_URL: "https://hbr.example.me" })).toBe(
      "https://hbr.example.me",
    );
  });

  test("non-default port is preserved (portal registration must match it)", () => {
    expect(canonicalAuthBaseURL({ HBR_BASE_URL: "http://192.168.1.10:3998" })).toBe(
      "http://192.168.1.10:3998",
    );
    expect(canonicalAuthBaseURL({ BETTER_AUTH_URL: "https://hbr.example.me:8443/" })).toBe(
      "https://hbr.example.me:8443",
    );
  });

  test("HBR_BASE_URL is the fallback alias", () => {
    expect(canonicalAuthBaseURL({ HBR_BASE_URL: "https://hbr.example.me" })).toBe(
      "https://hbr.example.me",
    );
  });

  test("non-http(s) scheme is rejected with a derivation hint", () => {
    expect(() => canonicalAuthBaseURL({ BETTER_AUTH_URL: "ftp://hbr.example.me" })).toThrow(
      /api\/auth\/callback/,
    );
  });

  test("a base URL with a path suffix is rejected (it corrupts callback URLs)", () => {
    expect(() => canonicalAuthBaseURL({ BETTER_AUTH_URL: "https://hbr.example.me/api" })).toThrow(
      /origin-only/,
    );
    expect(() => canonicalAuthBaseURL({ BETTER_AUTH_URL: "not a url" })).toThrow(
      /absolute http\(s\) URL/,
    );
  });
});

describe("Better Auth receives the canonical base URL", () => {
  test("env base (with trailing slash) yields the exact callback URL", async () => {
    const baseURL = await ctxBaseURL("https://hbr.example.me/");
    expect(baseURL).toBe("https://hbr.example.me/api/auth");
    expect(callbackFor("https://hbr.example.me", "discord")).toBe(
      "https://hbr.example.me/api/auth/callback/discord",
    );
    expect(callbackFor("https://hbr.example.me", "github")).toBe(
      "https://hbr.example.me/api/auth/callback/github",
    );
  });

  test("port-bearing base yields the port-bearing callback URL", async () => {
    const baseURL = await ctxBaseURL("http://127.0.0.1:3998");
    expect(baseURL).toBe("http://127.0.0.1:3998/api/auth");
    expect(callbackFor("http://127.0.0.1:3998", "discord")).toBe(
      "http://127.0.0.1:3998/api/auth/callback/discord",
    );
  });

  test("startup YAML base_url flows through the loader's env map", async () => {
    const tmp = `/tmp/hbr-test-config-${Date.now()}.yaml`;
    await Bun.write(tmp, 'auth:\n  base_url: "https://yaml.example.me/"\n');
    try {
      const cfg = await loadConfig({
        env: { HBR_CONFIG_FILE: tmp, DATABASE_URL: "postgres://u:p@127.0.0.1:55432/none" },
      });
      expect(cfg.auth.baseUrl).toBe("https://yaml.example.me/");
      // createAuth must read the merged record (cfg.env), not process.env.
      const auth = createAuth(db, cfg);
      const ctx = await auth.$context;
      expect(ctx.baseURL).toBe("https://yaml.example.me/api/auth");
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(tmp, { force: true });
    }
  });
});

describe("production without a base URL fails safely", () => {
  // bun test forces NODE_ENV=test, so the production gate runs in a
  // subprocess (same pattern as trusted-origins.test.ts).
  test("startup error names the missing variable, never a value", () => {
    const script = `
      const { createAuth } = await import("./src/auth");
      const { createDb } = await import("@hoborouter/db");
      try {
        const db = createDb("postgres://u:p@127.0.0.1:55432/none");
        createAuth(db);
        console.log("NO_ERROR");
      } catch (err) {
        console.log("ERROR: " + (err instanceof Error ? err.message : String(err)));
      }
    `;
    const proc = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        // Explicitly absent: BETTER_AUTH_URL, HBR_BASE_URL (NODE_ENV=production).
        ...process.env,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "x".repeat(32),
        DATABASE_URL: "postgres://u:p@127.0.0.1:55432/none",
        BETTER_AUTH_URL: undefined,
        HBR_BASE_URL: undefined,
      } as Record<string, string | undefined>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(out).toContain("BETTER_AUTH_URL (or HBR_BASE_URL) is required when NODE_ENV=production");
    expect(out).not.toContain("postgres://");
  });
});
