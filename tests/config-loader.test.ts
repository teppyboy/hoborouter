import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type LoadConfigOptions } from "../apps/api/src/config/loader";
import { ConfigError } from "../apps/api/src/config/schema";

// Source-of-truth proof for the gateway default: apps/api/src/routes/
// v1-gateway.ts disables only when HBR_GATEWAY_ENABLED === "0" — anything
// unset or otherwise enables it. The spec table's "false" contradicts the
// source; the loader preserves the source default (true).

const baseEnv = { DATABASE_URL: "postgres://db.example/test" } as const;

const load = (env: Record<string, string | undefined>) =>
  loadConfig({ env: { ...baseEnv, ...env } } satisfies LoadConfigOptions);

/** No DATABASE_URL in env: database.url must come from YAML or defaults. */
const loadYaml = (env: Record<string, string | undefined>) =>
  loadConfig({ env } satisfies LoadConfigOptions);

const errCode = async (p: Promise<unknown>): Promise<{ code: string; path: string }> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    const ce = e as ConfigError;
    return { code: ce.code, path: ce.path };
  }
  throw new Error("expected ConfigError, resolved instead");
};

let tmp: string;
const tmpFile = async (name: string, content: string): Promise<string> => {
  tmp ??= await mkdtemp(join(tmpdir(), "config-loader-"));
  const path = join(tmp, name);
  await writeFile(path, content);
  return path;
};

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("env-only resolution", () => {
  test("defaults apply with no env overrides", async () => {
    const cfg = await load({});
    expect(cfg.server.port).toBe(3000);
    expect(cfg.server.idleTimeoutS).toBe(255);
    expect(cfg.server.webDist).toBe("apps/web/dist");
    expect(cfg.server.avatarDir).toBe("./data/avatars");
    expect(cfg.auth.baseUrl).toBe("http://localhost:3000");
    expect(cfg.auth.trustedOrigins).toEqual([]);
    expect(cfg.cpa.baseUrl).toBe("http://cpa:8317");
    // Gateway default mirrors v1-gateway.ts:333 (`!== "0"` = enabled).
    expect(cfg.gateway.enabled).toBe(true);
    expect(cfg.billing.usdVndRate).toBe(26000);
    expect(cfg.payments.mock.enabled).toBe(true);
    expect(cfg.oauth.google).toBeUndefined();
    expect(cfg.email.smtp.host).toBeUndefined();
  });

  test("env values override defaults", async () => {
    const cfg = await load({ PORT: "8080", HBR_IDLE_TIMEOUT_S: "10" });
    expect(cfg.server.port).toBe(8080);
    expect(cfg.server.idleTimeoutS).toBe(10);
  });

  test("legacy boolean env values keep consumer semantics; token-less booleans stay strict", async () => {
    // gateway: documented "0" disables (old consumer === "0").
    expect((await load({ HBR_GATEWAY_ENABLED: "false" })).gateway.enabled).toBe(false);
    expect((await load({ HBR_GATEWAY_ENABLED: "0" })).gateway.enabled).toBe(false);
    // trust_proxy has NO legacy tokens: only "true" ever trusted a proxy.
    expect((await load({ HBR_TRUST_PROXY: "false" })).server.trustProxy).toBe(false);
    const bad = await errCode(load({ HBR_TRUST_PROXY: "1" }));
    expect(bad.code).toBe("CONFIG_INVALID_VALUE");
    expect(bad.path).toBe("server.trust_proxy");
  });

  test("integer env is strict", async () => {
    expect((await errCode(load({ PORT: "abc" }))).code).toBe("CONFIG_INVALID_VALUE");
    expect((await errCode(load({ PORT: "0" }))).path).toBe("server.port");
    expect((await errCode(load({ PORT: "1.5" }))).code).toBe("CONFIG_INVALID_VALUE");
  });

  test("present-but-empty env never falls back (required and optional)", async () => {
    const required = await errCode(load({ DATABASE_URL: "" }));
    expect(required).toEqual({ code: "CONFIG_INVALID_VALUE", path: "database.url" });
    const optional = await errCode(load({ HBR_WEB_DIST: "" }));
    expect(optional.path).toBe("server.web_dist");
  });

  test("trusted origins env is a comma list", async () => {
    const cfg = await load({ HBR_TRUSTED_ORIGINS: "https://a.example, https://b.example ," });
    expect(cfg.auth.trustedOrigins).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe("YAML file resolution", () => {
  test("YAML values load and override defaults", async () => {
    const path = await tmpFile(
      "full.yaml",
      [
        "server:",
        "  port: 4000",
        "database:",
        "  url: postgres://db.example/yaml",
        "gateway:",
        "  enabled: false",
        "billing:",
        "  usd_vnd_rate: 27000",
      ].join("\n"),
    );
    const cfg = await loadYaml({ HBR_CONFIG_FILE: path });
    expect(cfg.server.port).toBe(4000);
    expect(cfg.database.url).toBe("postgres://db.example/yaml");
    expect(cfg.gateway.enabled).toBe(false);
    expect(cfg.billing.usdVndRate).toBe(27000);
  });

  test("explicit env beats YAML per field", async () => {
    const path = await tmpFile(
      "override.yaml",
      ["server:", "  port: 4000", "database:", "  url: postgres://db.example/yaml"].join("\n"),
    );
    const cfg = await load({ HBR_CONFIG_FILE: path, PORT: "5000" });
    expect(cfg.server.port).toBe(5000);
    // DATABASE_URL comes from env (explicit env beats YAML).
    expect(cfg.database.url).toBe("postgres://db.example/test");
    // Non-overlapping YAML fields still resolve.
    expect(cfg.server.webDist).toBe("apps/web/dist");
  });

  test("default config.yaml absence is env-only", async () => {
    // No config.yaml exists in the process cwd for tests; absence must be OK.
    const cfg = await load({});
    expect(cfg.database.url).toBe("postgres://db.example/test");
  });

  test("explicit missing file fails; empty explicit path fails", async () => {
    const missing = await errCode(load({ HBR_CONFIG_FILE: "/nonexistent/config.yaml" }));
    expect(missing.code).toBe("CONFIG_FILE_UNREADABLE");
    const empty = await errCode(load({ HBR_CONFIG_FILE: "" }));
    expect(empty.code).toBe("CONFIG_FILE_UNREADABLE");
  });

  test("explicit empty file fails (null root is invalid, not env-only)", async () => {
    const path = await tmpFile("empty.yaml", "");
    const e = await errCode(load({ HBR_CONFIG_FILE: path }));
    expect(e.code).toBe("CONFIG_INVALID_VALUE");
    expect(e.path).toBe("(root)");
  });

  test("scalar and array roots are rejected", async () => {
    const scalar = await tmpFile("scalar.yaml", "just-a-string\n");
    expect((await errCode(load({ HBR_CONFIG_FILE: scalar }))).path).toBe("(root)");
    const list = await tmpFile("list.yaml", "- a\n- b\n");
    expect((await errCode(load({ HBR_CONFIG_FILE: list }))).path).toBe("(root)");
  });

  test("unknown keys are rejected with a redacted path (never the raw key)", async () => {
    const path = await tmpFile(
      "unknown.yaml",
      ["database:", "  url: postgres://db.example/yaml", "server:", "  prot: 4000"].join("\n"),
    );
    const e = await errCode(load({ HBR_CONFIG_FILE: path }));
    expect(e.code).toBe("CONFIG_UNKNOWN_KEY");
    expect(e.path).toBe("server.[redacted-key]");
    expect(e.path).not.toContain("prot");
  });

  test("YAML null is invalid rather than a default", async () => {
    const path = await tmpFile(
      "null.yaml",
      ["server:", "  port: null", "  web_dist: ~", "database:", "  url: postgres://d/x"].join("\n"),
    );
    const e = await errCode(load({ HBR_CONFIG_FILE: path }));
    expect(e).toEqual({ code: "CONFIG_INVALID_VALUE", path: "server.port" });
  });

  test("YAML types are strict: string port, string boolean fail", async () => {
    const path = await tmpFile(
      "types.yaml",
      ["server:", "  port: '4000'", "database:", "  url: postgres://d/x"].join("\n"),
    );
    expect((await errCode(load({ HBR_CONFIG_FILE: path }))).path).toBe("server.port");
    const path2 = await tmpFile(
      "types2.yaml",
      ["gateway:", "  enabled: 'true'", "database:", "  url: postgres://d/x"].join("\n"),
    );
    expect((await errCode(load({ HBR_CONFIG_FILE: path2 }))).path).toBe("gateway.enabled");
  });

  test("malformed YAML fails with a redacted error", async () => {
    const secretLine = "SECRET_MARKER_should_never_appear_in_errors";
    const path = await tmpFile("bad.yaml", `database:\n  url: ${secretLine}\n  : [oops\n`);
    const e = await errCode(load({ HBR_CONFIG_FILE: path }));
    expect(e.code).toBe("CONFIG_INVALID_VALUE");
    const ce = new ConfigError("CONFIG_INVALID_VALUE", "(root)");
    expect(ce.message).not.toContain(secretLine);
    expect(`${e.code} ${e.path}`).not.toContain(secretLine);
  });

  test("files over 1 MiB are rejected", async () => {
    const padding = "# " + "x".repeat(1024) + "\n";
    const path = await tmpFile("big.yaml", padding.repeat(1100));
    const e = await errCode(load({ HBR_CONFIG_FILE: path }));
    expect(e.code).toBe("CONFIG_FILE_TOO_LARGE");
  });
});

describe("aliases and identity preservation", () => {
  test("canonical auth.secret alias wins even when empty", async () => {
    // BETTER_AUTH_SECRET (canonical) present-but-empty must not fall through
    // to AUTH_SECRET or YAML.
    const path = await tmpFile(
      "secret.yaml",
      ["database:", "  url: postgres://db.example/yaml", "auth:", "  secret: fromyaml"].join("\n"),
    );
    const e = await errCode(
      loadConfig({
        env: {
          DATABASE_URL: "postgres://db.example/test",
          HBR_CONFIG_FILE: path,
          BETTER_AUTH_SECRET: "",
          AUTH_SECRET: "from-secondary",
        },
      }),
    );
    expect(e.path).toBe("auth.secret");

    const cfg = await loadConfig({
      env: {
        DATABASE_URL: "postgres://db.example/test",
        AUTH_SECRET: "from-secondary",
      },
    });
    expect(cfg.auth.secret).toBe("from-secondary");
  });

  test("canonical auth.base_url alias wins over secondary", async () => {
    const cfg = await load({
      BETTER_AUTH_URL: "https://canonical.example",
      HBR_BASE_URL: "https://secondary.example",
    });
    expect(cfg.auth.baseUrl).toBe("https://canonical.example");
  });

  test("identifier strings are preserved verbatim", async () => {
    const cfg = await load({ CPA_BASE_URL: "http://cpa.internal:8317/base/" });
    expect(cfg.cpa.baseUrl).toBe("http://cpa.internal:8317/base/");
  });

  test("resolved env map exposes canonical aliases for existing helpers", async () => {
    const path = await tmpFile(
      "envmap.yaml",
      [
        "auth:",
        "  trusted_origins:",
        "    - https://a.example",
        "    - https://b.example",
        "  oauth:",
        "    google:",
        "      client_id: yaml-id",
        "email:",
        "  smtp:",
        "    host: smtp.example",
        "    from: no-reply@example",
        "payments:",
        "  payos:",
        "      client_id: p-id",
        "      api_key: p-key",
        "      checksum_key: p-checksum",
      ].join("\n"),
    );
    const cfg = await loadConfig({
      env: {
        DATABASE_URL: "postgres://db.example/test",
        HBR_CONFIG_FILE: path,
        HBR_OAUTH_GOOGLE_CLIENT_SECRET: "env-secret",
        HBR_MOCK_PAYMENTS: "false",
        HBR_MOCK_PAYMENTS_WEBHOOK_KEY: "whk",
      },
    });
    expect(cfg.env.HBR_TRUSTED_ORIGINS).toBe("https://a.example,https://b.example");
    expect(cfg.env.HBR_OAUTH_GOOGLE_CLIENT_ID).toBe("yaml-id");
    expect(cfg.env.HBR_OAUTH_GOOGLE_CLIENT_SECRET).toBe("env-secret");
    expect(cfg.env.SMTP_HOST).toBe("smtp.example");
    expect(cfg.env.HBR_EMAIL_FROM).toBe("no-reply@example");
    expect(cfg.env.PAYOS_CLIENT_ID).toBe("p-id");
    expect(cfg.env.HBR_MOCK_PAYMENTS).toBe("off");
    expect(cfg.env.HBR_GATEWAY_ENABLED).toBe("1");
    expect(cfg.env.DATABASE_URL).toBe("postgres://db.example/test");
    // Absent optionals stay absent so helper defaults still apply.
    expect(Object.hasOwn(cfg.env, "SMTP_PORT")).toBe(false);
    expect(cfg.oauth.google).toEqual({ clientId: "yaml-id", clientSecret: "env-secret" });
  });

  test("mixed YAML ids + env secrets resolve into oauth group", async () => {
    const path = await tmpFile(
      "mixed-oauth.yaml",
      ["auth:", "  oauth:", "    discord:", "      client_id: yaml-discord-id"].join("\n"),
    );
    const cfg = await loadConfig({
      env: {
        DATABASE_URL: "postgres://db.example/test",
        HBR_CONFIG_FILE: path,
        HBR_OAUTH_DISCORD_CLIENT_SECRET: "env-discord-secret",
      },
    });
    expect(cfg.oauth.discord).toEqual({
      clientId: "yaml-discord-id",
      clientSecret: "env-discord-secret",
    });
  });
});

describe("new alias groups (max output tokens, trust proxy, dev admin email)", () => {
  test("defaults and env overrides for gateway/server/bootstrap additions", async () => {
    const def = await load({});
    // Absent key = no Hoborouter-imposed output default (unlimited); the env
    // map omits HBR_DEFAULT_MAX_OUTPUT_TOKENS entirely.
    expect(def.gateway.defaultMaxOutputTokens).toBeUndefined();
    expect(def.env.HBR_DEFAULT_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(def.gateway.upstreamHeadersTimeoutMs).toBe(120000);
    expect(def.server.trustProxy).toBeUndefined();
    expect(def.bootstrap.devAdminEmail).toBeUndefined();
    const env = await load({
      HBR_DEFAULT_MAX_OUTPUT_TOKENS: "2048",
      HBR_TRUST_PROXY: "true",
      HBR_DEV_ADMIN_EMAIL: "dev@t.local",
      HBR_UPSTREAM_HEADERS_TIMEOUT_MS: "45000",
    });
    expect(env.gateway.defaultMaxOutputTokens).toBe(2048);
    expect(env.gateway.upstreamHeadersTimeoutMs).toBe(45000);
    expect(env.server.trustProxy).toBe(true);
    expect(env.bootstrap.devAdminEmail).toBe("dev@t.local");
    // env map carries canonical aliases for downstream env-record helpers.
    expect(env.env.HBR_DEFAULT_MAX_OUTPUT_TOKENS).toBe("2048");
    expect(env.env.HBR_TRUST_PROXY).toBe("true");
    expect(env.env.HBR_DEV_ADMIN_EMAIL).toBe("dev@t.local");
  });

  test("default_max_output_tokens: empty env and YAML null are invalid, no fallthrough", async () => {
    await expect(load({ HBR_DEFAULT_MAX_OUTPUT_TOKENS: "" })).rejects.toBeInstanceOf(ConfigError);
    await expect(load({ HBR_DEFAULT_MAX_OUTPUT_TOKENS: "0" })).rejects.toBeInstanceOf(ConfigError);
    const file = await tmpFile(
      "null-max-output.yaml",
      [
        "gateway:",
        "  default_max_output_tokens:",
        "database:",
        '  url: "postgres://db.example/test"',
      ].join("\n"),
    );
    await expect(loadYaml({ HBR_CONFIG_FILE: file })).rejects.toBeInstanceOf(ConfigError);
  });

  test("YAML values for the new groups; wrong-typed env fails without fallback", async () => {
    const file = await tmpFile(
      "new-groups.yaml",
      [
        "server:",
        "  trust_proxy: true",
        "gateway:",
        "  default_max_output_tokens: 1024",
        "  upstream_headers_timeout_ms: 30000",
        "bootstrap:",
        "  dev_admin_email: yaml@t.local",
        "database:",
        '  url: "postgres://db.example/test"',
      ].join("\n"),
    );
    const cfg = await loadYaml({ HBR_CONFIG_FILE: file });
    expect(cfg.server.trustProxy).toBe(true);
    expect(cfg.gateway.defaultMaxOutputTokens).toBe(1024);
    expect(cfg.gateway.upstreamHeadersTimeoutMs).toBe(30000);
    expect(cfg.bootstrap.devAdminEmail).toBe("yaml@t.local");
    // Explicit env beats YAML per field — even for the new knob.
    expect(
      (await loadYaml({ HBR_CONFIG_FILE: file, HBR_UPSTREAM_HEADERS_TIMEOUT_MS: "60000" })).gateway
        .upstreamHeadersTimeoutMs,
    ).toBe(60000);
    await expect(loadYaml({ HBR_CONFIG_FILE: file, HBR_TRUST_PROXY: "1" })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe("post-merge gate", () => {
  test("database.url is required and must be postgres", async () => {
    const missing = await errCode(loadConfig({ env: {} }));
    expect(missing).toEqual({ code: "CONFIG_MISSING_REQUIRED", path: "database.url" });
    const nonPg = await errCode(load({ DATABASE_URL: "mysql://x/y" }));
    expect(nonPg).toEqual({ code: "CONFIG_INVALID_VALUE", path: "database.url" });
    const postgresScheme = await load({ DATABASE_URL: "postgresql://x/y" });
    expect(postgresScheme.database.url).toBe("postgresql://x/y");
  });

  test("production requires an explicit >=32 char secret and base URL", async () => {
    const prod = (env: Record<string, string | undefined>) =>
      loadConfig({ env: { ...baseEnv, NODE_ENV: "production", ...env } });
    expect((await errCode(prod({}))).path).toBe("auth.secret");
    const short = await errCode(prod({ BETTER_AUTH_SECRET: "too-short" }));
    expect(short).toEqual({ code: "CONFIG_INVALID_VALUE", path: "auth.secret" });
    // The dev default for base_url never satisfies the production requirement.
    const withSecret = await errCode(prod({ BETTER_AUTH_SECRET: "x".repeat(32) }));
    expect(withSecret).toEqual({ code: "CONFIG_MISSING_REQUIRED", path: "auth.base_url" });
    const ok = await prod({
      BETTER_AUTH_SECRET: "x".repeat(32),
      BETTER_AUTH_URL: "https://api.example",
    });
    expect(ok.auth.secret).toBe("x".repeat(32));
  });

  test("partial SMTP group fails after merge; all-absent stays disabled", async () => {
    expect((await errCode(load({ SMTP_HOST: "smtp.example" }))).path).toBe("email.smtp.from");
    expect((await errCode(load({ HBR_EMAIL_FROM: "a@b" }))).path).toBe("email.smtp.host");
    expect((await errCode(load({ SMTP_USER: "u" }))).path).toBe("email.smtp.password");
    expect((await errCode(load({ SMTP_PASSWORD: "p" }))).path).toBe("email.smtp.user");
    const disabled = await load({});
    expect(disabled.email.smtp.host).toBeUndefined();
  });

  test("partial OAuth pair fails; complete pair passes", async () => {
    expect((await errCode(load({ HBR_OAUTH_GOOGLE_CLIENT_ID: "id" }))).path).toBe(
      "auth.oauth.google.client_secret",
    );
    expect((await errCode(load({ HBR_OAUTH_GITHUB_CLIENT_SECRET: "s" }))).path).toBe(
      "auth.oauth.github.client_id",
    );
  });

  test("partial payOS triple fails; all-absent stays disabled", async () => {
    expect((await errCode(load({ PAYOS_CLIENT_ID: "id" }))).path).toBe("payments.payos.api_key");
    expect((await errCode(load({ PAYOS_CLIENT_ID: "i", PAYOS_API_KEY: "k" }))).path).toBe(
      "payments.payos.checksum_key",
    );
    const disabled = await load({});
    expect(disabled.payments.payos.clientId).toBeUndefined();
  });

  test("captcha secret without site key fails after merge", async () => {
    expect((await errCode(load({ TURNSTILE_SECRET_KEY: "s" }))).path).toBe(
      "captcha.turnstile.site_key",
    );
  });

  test("YAML partial group fails after merge too", async () => {
    const path = await tmpFile(
      "partial-payos.yaml",
      ["payments:", "  payos:", "    api_key: k", "database:", "  url: postgres://d/x"].join("\n"),
    );
    expect((await errCode(load({ HBR_CONFIG_FILE: path }))).path).toBe("payments.payos.client_id");
  });

  test("NODE_ENV cannot come from YAML (unknown key)", async () => {
    const path = await tmpFile(
      "nodeenv.yaml",
      ["node_env: production", "database:", "  url: postgres://d/x"].join("\n"),
    );
    const e = await errCode(load({ HBR_CONFIG_FILE: path }));
    expect(e.code).toBe("CONFIG_UNKNOWN_KEY");
    // Redacted: the raw key text never reaches the path or message.
    expect(e.path).toBe("[redacted-key]");
  });
});

describe("immutability", () => {
  test("resolved config is deeply frozen", async () => {
    const cfg = await load({ PORT: "8080" });
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.server)).toBe(true);
    expect(Object.isFrozen(cfg.email)).toBe(true);
    expect(Object.isFrozen(cfg.email.smtp)).toBe(true);
    expect(Object.isFrozen(cfg.env)).toBe(true);
    expect(Object.isFrozen(cfg.auth.trustedOrigins)).toBe(true);
  });
});

// P1 regression: legacy boolean env values keep their documented semantics,
// and the resolved env record serializes back to the EXACT format each old
// consumer checks (gateway: "0" disables; mock: "off" disables;
// trust_proxy: only "true" trusts). A generic "false" string must not be the
// only wire format — see v1-gateway.ts, mock-config.ts, support-leads.ts.
describe("legacy boolean env compatibility", () => {
  test("HBR_GATEWAY_ENABLED=0 disables; env map echoes '0'", async () => {
    const cfg = await load({ HBR_GATEWAY_ENABLED: "0" });
    expect(cfg.gateway.enabled).toBe(false);
    expect(cfg.env.HBR_GATEWAY_ENABLED).toBe("0");
  });

  test("HBR_GATEWAY_ENABLED=1 and 'true' enable; env map echoes '1'", async () => {
    expect((await load({ HBR_GATEWAY_ENABLED: "1" })).gateway.enabled).toBe(true);
    expect((await load({ HBR_GATEWAY_ENABLED: "1" })).env.HBR_GATEWAY_ENABLED).toBe("1");
    expect((await load({ HBR_GATEWAY_ENABLED: "true" })).env.HBR_GATEWAY_ENABLED).toBe("1");
  });

  test("HBR_MOCK_PAYMENTS=off disables; 'on' enables; env map echoes legacy pair", async () => {
    const off = await load({ HBR_MOCK_PAYMENTS: "off" });
    expect(off.payments.mock.enabled).toBe(false);
    expect(off.env.HBR_MOCK_PAYMENTS).toBe("off");
    const on = await load({ HBR_MOCK_PAYMENTS: "on" });
    expect(on.payments.mock.enabled).toBe(true);
    expect(on.env.HBR_MOCK_PAYMENTS).toBe("on");
  });

  test("YAML false serializes to consumer formats ('0' gateway, 'off' mock)", async () => {
    const file = await tmpFile(
      "bools.yaml",
      [
        "database:",
        '  url: "postgres://db.example/test"',
        "gateway:",
        "  enabled: false",
        "payments:",
        "  mock:",
        "    enabled: false",
      ].join("\n"),
    );
    const cfg = await loadYaml({ HBR_CONFIG_FILE: file });
    expect(cfg.gateway.enabled).toBe(false);
    expect(cfg.env.HBR_GATEWAY_ENABLED).toBe("0");
    expect(cfg.payments.mock.enabled).toBe(false);
    expect(cfg.env.HBR_MOCK_PAYMENTS).toBe("off");
  });

  test("HBR_TRUST_PROXY accepts only true/false; env map echoes 'true'/'false'", async () => {
    const t = await load({ HBR_TRUST_PROXY: "true" });
    expect(t.server.trustProxy).toBe(true);
    expect(t.env.HBR_TRUST_PROXY).toBe("true");
    const f = await load({ HBR_TRUST_PROXY: "false" });
    expect(f.server.trustProxy).toBe(false);
    expect(f.env.HBR_TRUST_PROXY).toBe("false");
    // Legacy '1' never trusted a proxy, so it is NOT a valid token here.
    await expect(load({ HBR_TRUST_PROXY: "1" })).rejects.toBeInstanceOf(ConfigError);
  });

  test("env overriding invalid YAML is not a premature failure", async () => {
    const file = await tmpFile(
      "bad-yaml-bool.yaml",
      [
        "database:",
        '  url: "postgres://db.example/test"',
        "gateway:",
        "  enabled: definitely-not-a-bool",
      ].join("\n"),
    );
    const cfg = await loadConfig({ env: { HBR_CONFIG_FILE: file, HBR_GATEWAY_ENABLED: "0" } });
    expect(cfg.gateway.enabled).toBe(false);
  });
});

// P1 regression: unknown YAML keys are REDACTED. The raw key text (which can
// be a pasted secret) must never appear in the error path or message; the
// known parent prefix stays visible for diagnosis.
describe("unknown-key redaction", () => {
  test("secret-looking top-level key is redacted; parent and code visible", async () => {
    const secretish = "sk-live-abc123xyzSUPERSECRET";
    let err: unknown;
    try {
      await loadYaml({
        HBR_CONFIG_FILE: await tmpFile(
          "leak.yaml",
          [`database:\n  url: postgres://db.example/t`, `${secretish}: oops`].join("\n"),
        ),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const ce = err as ConfigError;
    expect(ce.code).toBe("CONFIG_UNKNOWN_KEY");
    expect(ce.path).not.toContain(secretish);
    expect(ce.message).not.toContain(secretish);
    expect(ce.path).not.toContain("oops");
  });

  test("nested unknown key under a known group keeps the safe prefix only", async () => {
    const secretish = "AKIAVERYLONGSECRETKEYVALUE";
    let err: unknown;
    try {
      await loadYaml({
        HBR_CONFIG_FILE: await tmpFile(
          "nested-leak.yaml",
          [
            "database:",
            "  url: postgres://db.example/t",
            "auth:",
            "  oauth:",
            "    google:",
            `      ${secretish}: value`,
          ].join("\n"),
        ),
      });
    } catch (e) {
      err = e;
    }
    const ce = err as ConfigError;
    expect(ce.code).toBe("CONFIG_UNKNOWN_KEY");
    expect(ce.path.startsWith("auth.oauth.google")).toBe(true);
    expect(ce.path).not.toContain(secretish);
    expect(ce.message).not.toContain(secretish);
  });

  test("very large unknown key name is not echoed", async () => {
    const big = "X".repeat(5000);
    let err: unknown;
    try {
      await loadYaml({
        HBR_CONFIG_FILE: await tmpFile(
          "big-leak.yaml",
          [`database:\n  url: postgres://db.example/t`, `${big}: v`].join("\n"),
        ),
      });
    } catch (e) {
      err = e;
    }
    const ce = err as ConfigError;
    expect(ce.code).toBe("CONFIG_UNKNOWN_KEY");
    expect(ce.message.length).toBeLessThan(300);
    expect(ce.path.length).toBeLessThan(300);
    expect(ce.message).not.toContain(big);
  });
});
