// Startup config integration: the resolved config (YAML + env merged by
// apps/api/src/config/loader.ts) flows into buildApp/createAuth/routes as
// explicit injected values — never via process.env mutation. Env-only callers
// keep today's behavior (helpers default to process.env).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type Db } from "../packages/db/src/index";
import { buildApp } from "../apps/api/src/app";
import { loadConfig } from "../apps/api/src/config/loader";
import { ConfigError } from "../apps/api/src/config/schema";
import { payosConfigFromEnv } from "../packages/payments/src/provider";
import { mockWebhookConfig } from "../apps/api/src/mock-config";
import type { BetterAuthInstance } from "../apps/api/src/auth-types";
import type { ResolvedConfig } from "../apps/api/src/config/schema";

const fakeAuth = (userId: string | null): BetterAuthInstance => ({
  handler: async () => new Response(null, { status: 404 }),
  api: {
    getSession: async () =>
      userId ? { user: { id: userId }, session: { id: `sess-${userId}`, userId } } : null,
  },
});

async function api(
  app: Awaited<ReturnType<typeof buildApp>>,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.handle(new Request(`http://test${path}`));
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

let db: Db;
let drop: () => Promise<void>;
// The suite never starts services (AGENTS.md): DB-backed cases run only when
// the shared test Postgres is already up; the gate test stays DB-free.
const TEST_BASE =
  process.env.HBR_TEST_DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:55432/postgres";
const pgUp = await (async () => {
  try {
    const probe = new SQL(TEST_BASE);
    await probe.unsafe("select 1");
    await probe.close();
    return true;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  if (!pgUp) return;
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
});
afterAll(async () => {
  if (pgUp) await drop();
});

describe.skipIf(!pgUp)("resolved config injection into buildApp", () => {
  test("public-config reflects cfg (OAuth pair + Turnstile), not process.env", async () => {
    // Explicit env (HBR_OAUTH_GOOGLE_* pair + Turnstile keys) resolves through
    // the loader; ambient process.env has none of these.
    const cfg = await loadConfig({
      env: {
        DATABASE_URL: "postgres://placeholder:placeholder@127.0.0.1:55432/placeholder",
        HBR_OAUTH_GOOGLE_CLIENT_ID: "cfg-google-id",
        HBR_OAUTH_GOOGLE_CLIENT_SECRET: "cfg-google-secret",
        TURNSTILE_SITE_KEY: "cfg-site-key",
        TURNSTILE_SECRET_KEY: "cfg-secret-key",
      },
    });
    expect(cfg.oauth.google).toEqual({
      clientId: "cfg-google-id",
      clientSecret: "cfg-google-secret",
    });
    const app = await buildApp({ db, auth: fakeAuth(null), cfg });
    const { status, body } = await api(app, "/api/v1/public-config");
    expect(status).toBe(200);
    const social = body.socialProviders as Record<string, boolean>;
    expect(social.google).toBe(true);
    expect(social.discord).toBe(false);
    expect(social.github).toBe(false);
    expect(body.turnstileSiteKey).toBe("cfg-site-key");
  });

  test("mixed config: provider id from YAML, secret from env resolves the pair", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hbr-cfg-"));
    const file = join(dir, "config.yaml");
    writeFileSync(
      file,
      [
        "database:",
        '  url: "postgres://placeholder:placeholder@127.0.0.1:55432/placeholder"',
        "auth:",
        "  oauth:",
        "    github:",
        '      client_id: "yaml-github-id"',
        "    discord:",
        '      client_id: "yaml-discord-id"',
        '      client_secret: "yaml-discord-secret"',
      ].join("\n"),
    );
    const cfg = await loadConfig({
      env: {
        HBR_CONFIG_FILE: file,
        HBR_OAUTH_GITHUB_CLIENT_SECRET: "env-github-secret",
      },
    });
    expect(cfg.oauth.github).toEqual({
      clientId: "yaml-github-id",
      clientSecret: "env-github-secret",
    });
    expect(cfg.oauth.discord).toEqual({
      clientId: "yaml-discord-id",
      clientSecret: "yaml-discord-secret",
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("payer provider config via resolved records (no provider request)", async () => {
    const cfg = await loadConfig({
      env: {
        DATABASE_URL: "postgres://placeholder:placeholder@127.0.0.1:55432/placeholder",
        PAYOS_CLIENT_ID: "cfg-payos-id",
        PAYOS_API_KEY: "cfg-payos-key",
        PAYOS_CHECKSUM_KEY: "cfg-payos-checksum",
        HBR_MOCK_PAYMENTS_WEBHOOK_KEY: "cfg-mock-key",
      },
    });
    const payos = payosConfigFromEnv(cfg.env);
    expect(payos).toEqual({
      available: true,
      clientId: "cfg-payos-id",
      apiKey: "cfg-payos-key",
      checksumKey: "cfg-payos-checksum",
    });
    const mock = mockWebhookConfig(cfg.env);
    expect(mock.enabled).toBe(true);
    expect(mock.webhookKey).toBe("cfg-mock-key");
  });

  test("buildApp honors cfg for webDist/CPA reads via cfg.env (gateway stays on)", async () => {
    const cfg: ResolvedConfig = await loadConfig({
      env: {
        DATABASE_URL: "postgres://placeholder:placeholder@127.0.0.1:55432/placeholder",
        HBR_GATEWAY_ENABLED: "true",
        CPA_BASE_URL: "http://cfg-cpa:8317",
      },
    });
    // Boots with the merged record: gateway enabled, no CPA key configured.
    // The gateway route reports its disabled/unconfigured state from cfg values
    // (a POST without a key is a 503, not a crash or a network call).
    const app = await buildApp({ db, auth: fakeAuth(null), cfg });
    const res = await app.handle(
      new Request("http://test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-hbr-none" },
        body: JSON.stringify({ model: "m", messages: [] }),
      }),
    );
    expect([401, 503]).toContain(res.status);
  });
});

describe("post-merge startup gate", () => {
  test("production without auth.secret fails with sanitized field path only", async () => {
    let err: unknown;
    try {
      await loadConfig({
        env: { NODE_ENV: "production", DATABASE_URL: "postgres://db:5432/app" },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const ce = err as ConfigError;
    expect(ce.code).toBe("CONFIG_MISSING_REQUIRED");
    expect(ce.path).toBe("auth.secret");
    // Redaction: never a value, never file/parser text.
    expect(ce.message).not.toContain("postgres://");
    expect(ce.message).not.toContain("db:5432");
  });
});

describe("entry boot subprocess (YAML port, env DATABASE_URL override)", () => {
  const BOOT_PORT = 4593;

  test("boots on the YAML port with env database.url overriding YAML", async () => {
    if (!pgUp) return;
    const dir = mkdtempSync(join(tmpdir(), "hbr-boot-"));
    const file = join(dir, "config.yaml");
    writeFileSync(
      file,
      [
        `server:\n  port: ${BOOT_PORT}`,
        // Deliberately unusable YAML db URL: boot proves the explicit env
        // DATABASE_URL wins per-field (env > YAML) and the API serves.
        'database:\n  url: "postgres://placeholder:placeholder@127.0.0.1:1/none"',
        'auth:\n  secret: "0123456789abcdef0123456789abcdef"',
      ].join("\n"),
    );
    // PORT is the env alias for server.port (env > YAML). The official gate
    // exports PORT=3998, which the child would inherit and boot on — the YAML
    // port under test would then never serve. Strip it so YAML wins.
    const childEnv: Record<string, string | undefined> = { ...process.env };
    delete childEnv.PORT;
    childEnv.HBR_CONFIG_FILE = file;
    childEnv.DATABASE_URL = TEST_BASE;
    childEnv.HBR_WEB_DIST = "definitely-missing-dist";
    const child = Bun.spawn(["bun", "apps/api/src/index.ts"], {
      cwd: process.cwd(),
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let served = false;
      let childDied = false;
      for (let i = 0; i < 60; i++) {
        // Fail fast if the child exits before ever serving; a full poll loop
        // on a dead child just burns the test budget.
        if (child.exitCode !== null) {
          childDied = true;
          break;
        }
        try {
          const res = await fetch(`http://127.0.0.1:${BOOT_PORT}/healthz`, {
            signal: AbortSignal.timeout(1000),
          });
          if (res.ok) {
            served = true;
            break;
          }
        } catch {
          await Bun.sleep(500);
        }
      }
      if (childDied) {
        // Config values (db URL, secrets) must never appear in the failure.
        const errText = await new Response(child.stderr).text();
        const sanitized = errText
          .replace(/postgres:\/\/[^\s"']+/g, "postgres://[REDACTED]")
          .replace(/(secret|password|api[_-]?key|checksum)[=:"']\s*[^\s"']+/gi, "$1=[REDACTED]");
        throw new Error(
          `boot subprocess exited (code ${child.exitCode}) before serving; sanitized stderr:\n${sanitized}`,
        );
      }
      expect(served).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
