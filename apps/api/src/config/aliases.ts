// Alias map between YAML config paths and environment variables, per the
// approved spec (docs/superpowers/specs/2026-10-09-yaml-configuration.md).
// Canonical (first) env alias wins whenever it is present in the environment —
// even when its value is empty — so a deployment can never accidentally fall
// through a blank canonical variable to a secondary alias or the YAML file.
//
// Defaults mirror the current env-reading source of truth:
//   - gateway.enabled default true (apps/api/src/routes/v1-gateway.ts:333 —
//     `HBR_GATEWAY_ENABLED === "0"` disables; anything else enables). The spec
//     table's "false" contradicts the source and is not followed here.
//   - payments.mock.enabled default true (apps/api/src/mock-config.ts —
//     `HBR_MOCK_PAYMENTS !== "off"`).
//   - server.idle_timeout_s default 255 (apps/api/src/index.ts — Bun's max).
// NODE_ENV is deliberately absent: it stays a runtime env-only selector.

export type FieldKind = "string" | "int" | "boolean" | "stringList" | "smtpSecure";

export interface FieldSpec {
  /** Dotted YAML path, e.g. "server.port". Also used as the error path. */
  readonly path: string;
  /** Environment aliases, canonical first. */
  readonly env: readonly string[];
  readonly kind: FieldKind;
  /** Inclusive integer bounds (kind "int" only). */
  readonly min?: number;
  readonly max?: number;
  /** Optional default; fields without one are optional-or-required. */
  readonly default?: string | number | boolean | readonly string[];
  /** Legacy boolean env tokens (kind "boolean" only). `truthy`/`falsy` are
   *  the env strings the OLD consumer accepted, and `out` is the exact wire
   *  format the resolved env record serializes back to so downstream checks
   *  (e.g. gateway `=== "0"`, mock `!== "off"`) keep their semantics. Fields
   *  without this use strict "true"/"false" only. */
  readonly booleanTokens?: {
    readonly truthy: readonly string[];
    readonly falsy: readonly string[];
    readonly out: readonly [string, string];
  };
}

const smtpSecure = (path: string, env: string): FieldSpec => ({
  path,
  env: [env],
  kind: "smtpSecure",
});

const oauthProvider = (id: "google" | "discord" | "github"): readonly [FieldSpec, FieldSpec] => {
  const suffix = id.toUpperCase();
  return [
    { path: `auth.oauth.${id}.client_id`, env: [`HBR_OAUTH_${suffix}_CLIENT_ID`], kind: "string" },
    {
      path: `auth.oauth.${id}.client_secret`,
      env: [`HBR_OAUTH_${suffix}_CLIENT_SECRET`],
      kind: "string",
    },
  ];
};

const [googleId, googleSecret] = oauthProvider("google");
const [discordId, discordSecret] = oauthProvider("discord");
const [githubId, githubSecret] = oauthProvider("github");

export const FIELD_SPECS: readonly FieldSpec[] = [
  { path: "server.port", env: ["PORT"], kind: "int", min: 1, max: 65535, default: 3000 },
  {
    path: "server.idle_timeout_s",
    env: ["HBR_IDLE_TIMEOUT_S"],
    kind: "int",
    min: 1,
    max: 255,
    default: 255,
  },
  { path: "server.web_dist", env: ["HBR_WEB_DIST"], kind: "string", default: "apps/web/dist" },
  {
    path: "server.avatar_dir",
    env: ["HBR_AVATAR_DIR"],
    kind: "string",
    default: "./data/avatars",
  },
  {
    // X-Forwarded-For trust for rate-limit client addressing (support-lead
    // intake). Same boolean env semantics as before; absent = socket address.
    path: "server.trust_proxy",
    env: ["HBR_TRUST_PROXY"],
    kind: "boolean",
  },
  { path: "database.url", env: ["DATABASE_URL"], kind: "string" },
  { path: "auth.secret", env: ["BETTER_AUTH_SECRET", "AUTH_SECRET"], kind: "string" },
  {
    path: "auth.base_url",
    env: ["BETTER_AUTH_URL", "HBR_BASE_URL"],
    kind: "string",
    default: "http://localhost:3000",
  },
  { path: "auth.trusted_origins", env: ["HBR_TRUSTED_ORIGINS"], kind: "stringList", default: [] },
  googleId,
  googleSecret,
  discordId,
  discordSecret,
  githubId,
  githubSecret,
  {
    path: "bootstrap.instance_admin_email",
    env: ["HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL"],
    kind: "string",
  },
  {
    // Dev/test-only auto-admin grant email; effective ONLY when NODE_ENV is
    // development/test (enforced at the auth.ts usage site, as before).
    path: "bootstrap.dev_admin_email",
    env: ["HBR_DEV_ADMIN_EMAIL"],
    kind: "string",
  },
  { path: "email.smtp.host", env: ["SMTP_HOST"], kind: "string" },
  { path: "email.smtp.from", env: ["HBR_EMAIL_FROM"], kind: "string" },
  { path: "email.smtp.port", env: ["SMTP_PORT"], kind: "int", min: 1, max: 65535 },
  smtpSecure("email.smtp.secure", "HBR_SMTP_SECURE"),
  { path: "email.smtp.user", env: ["SMTP_USER"], kind: "string" },
  { path: "email.smtp.password", env: ["SMTP_PASSWORD"], kind: "string" },
  { path: "captcha.turnstile.site_key", env: ["TURNSTILE_SITE_KEY"], kind: "string" },
  { path: "captcha.turnstile.secret_key", env: ["TURNSTILE_SECRET_KEY"], kind: "string" },
  { path: "cpa.base_url", env: ["CPA_BASE_URL"], kind: "string", default: "http://cpa:8317" },
  { path: "cpa.access_key", env: ["CPA_ACCESS_KEY"], kind: "string" },
  { path: "cpa.management_key", env: ["CPA_MANAGEMENT_KEY"], kind: "string" },
  {
    path: "gateway.enabled",
    env: ["HBR_GATEWAY_ENABLED"],
    kind: "boolean",
    default: true,
    // Old consumer (v1-gateway.ts): disabled ONLY when env === "0".
    booleanTokens: { truthy: ["true", "1"], falsy: ["false", "0"], out: ["1", "0"] },
  },
  {
    // Optional default max-output-tokens for gateway requests without an
    // explicit limit. Absent key = no Hoborouter-imposed default (unlimited;
    // billing holds the model's full context window instead). No 4096 fallback.
    path: "gateway.default_max_output_tokens",
    env: ["HBR_DEFAULT_MAX_OUTPUT_TOKENS"],
    kind: "int",
    min: 1,
  },
  {
    // Timeout for receiving upstream response HEADERS in the gateway proxy
    // (same intEnv semantics as before; non-positive values fall back to the
    // default at the call site).
    path: "gateway.upstream_headers_timeout_ms",
    env: ["HBR_UPSTREAM_HEADERS_TIMEOUT_MS"],
    kind: "int",
    min: 1,
    default: 120000,
  },
  {
    path: "billing.usd_vnd_rate",
    env: ["HBR_USD_VND_RATE"],
    kind: "int",
    min: 1,
    default: 26000,
  },
  { path: "payments.payos.client_id", env: ["PAYOS_CLIENT_ID"], kind: "string" },
  { path: "payments.payos.api_key", env: ["PAYOS_API_KEY"], kind: "string" },
  { path: "payments.payos.checksum_key", env: ["PAYOS_CHECKSUM_KEY"], kind: "string" },
  {
    path: "payments.mock.enabled",
    env: ["HBR_MOCK_PAYMENTS"],
    kind: "boolean",
    default: true,
    // Old consumer (mock-config.ts): disabled ONLY when env === "off".
    booleanTokens: {
      truthy: ["true", "on", "1"],
      falsy: ["false", "off", "0"],
      out: ["on", "off"],
    },
  },
  {
    path: "payments.mock.webhook_key",
    env: ["HBR_MOCK_PAYMENTS_WEBHOOK_KEY"],
    kind: "string",
  },
];

export const SMTP_SECURE_VALUES = ["starttls", "ssl", "none"] as const;
export type SmtpSecure = (typeof SMTP_SECURE_VALUES)[number];
