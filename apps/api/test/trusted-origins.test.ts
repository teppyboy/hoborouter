// Loopback origin trust: 127.0.0.1 and localhost are distinct origins. Dev/test
// trust the loopback-swapped baseURL origin; production must not.
//
// The production-rejection case runs in a subprocess: bun test forces
// NODE_ENV=test, and better-auth caches nodeENV at import (skipOriginCheck
// defaults to true in test env), so the CSRF origin check cannot be exercised
// in-process.
import { describe, test, expect, beforeEach } from "bun:test";
import { makeApp } from "./helpers";

const signUpWithOrigin = async (app: Awaited<ReturnType<typeof makeApp>>["app"], origin: string) =>
  app.handle(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie: "better-auth.session_data=x" },
      body: JSON.stringify({
        email: `u${Math.random().toString(36).slice(2)}@e2e.test`,
        password: "correct horse battery staple",
        name: "U",
      }),
    }),
  );

describe("trusted origins (loopback swap)", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_URL = "http://localhost:5199";
    process.env.BETTER_AUTH_SECRET = "x".repeat(32);
    delete process.env.HBR_TRUSTED_ORIGINS;
  });

  test("development: Origin http://127.0.0.1:<port> accepted when baseURL uses localhost", async () => {
    process.env.NODE_ENV = "development";
    const app = await makeApp();
    const res = await signUpWithOrigin(app.app, "http://127.0.0.1:5199");
    expect(res.status).toBe(200);
  });

  test("production: same mismatched origin rejected", async () => {
    // Minimal Better Auth instance in a real NODE_ENV=production process.
    const script = `
      const { createAuth } = await import("./src/auth");
      const { createTestDb } = await import("@hoborouter/db");
      const t = await createTestDb();
      const auth = createAuth(t.db);
      const res = await auth.handler(new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5199", cookie: "x=1" },
        body: JSON.stringify({ email: "a@b.test", password: "correct horse battery staple", name: "U" }),
      }));
      console.log("STATUS " + res.status);
      await t.drop();
    `;
    const proc = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        NODE_ENV: "production",
        TEST: "",
        BETTER_AUTH_URL: "http://localhost:5199",
        BETTER_AUTH_SECRET: "x".repeat(32),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(out).toContain("STATUS 403");
  });

  test("production: trustedOrigins excludes the loopback-swapped origin", async () => {
    process.env.NODE_ENV = "production";
    const app = await makeApp();
    const ctx = await app.auth.$context;
    expect(ctx.trustedOrigins).not.toContain("http://127.0.0.1:5199");
  });

  test("HBR_TRUSTED_ORIGINS entries are trusted in any environment", async () => {
    process.env.NODE_ENV = "production";
    process.env.HBR_TRUSTED_ORIGINS = "https://app.example.com , http://192.168.1.10:5173";
    const app = await makeApp();
    const ctx = await app.auth.$context;
    expect(ctx.trustedOrigins).toContain("https://app.example.com");
    expect(ctx.trustedOrigins).toContain("http://192.168.1.10:5173");
  });
});
