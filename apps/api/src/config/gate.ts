import { ConfigError, type ConfigErrorCode } from "./schema";

// Post-merge startup gate: requiredness and group completeness are evaluated
// AFTER env/YAML merging, exactly once. Failures name the selected field path
// and a stable code — never a value, secret, or parser message.

export interface GateInput {
  /** Resolved leaf values by dotted path (present only when resolved). */
  readonly values: ReadonlyMap<string, unknown>;
  /** Paths that came from env or YAML (not from a default). */
  readonly explicit: ReadonlySet<string>;
  /** Runtime security mode; NODE_ENV stays env-only by contract. */
  readonly nodeEnv: string | undefined;
}

const str = (values: GateInput["values"], path: string): string | undefined => {
  const v = values.get(path);
  return typeof v === "string" ? v : undefined;
};

const fail = (code: ConfigErrorCode, path: string): never => {
  throw new ConfigError(code, path);
};

/** Partial-group rule: every member of `paths` must be present when ANY member
 *  is. The first missing member's path is reported. */
const requireGroup = (input: GateInput, paths: readonly string[]): void => {
  const anyPresent = paths.some((p) => input.values.has(p));
  if (!anyPresent) return;
  for (const p of paths) {
    if (!input.values.has(p)) fail("CONFIG_MISSING_REQUIRED", p);
  }
};

const requireProdString = (input: GateInput, path: string, minLength?: number): void => {
  // Defaults never satisfy production requirements; only env/YAML do.
  if (!input.explicit.has(path)) fail("CONFIG_MISSING_REQUIRED", path);
  const v = str(input.values, path);
  if (minLength !== undefined && v !== undefined && v.length < minLength) {
    fail("CONFIG_INVALID_VALUE", path);
  }
};

export const validateResolvedConfig = (input: GateInput): void => {
  const { values, nodeEnv } = input;
  const isProduction = nodeEnv === "production";

  // database.url is required in every mode and must be a postgres URL.
  const dbUrl = str(values, "database.url");
  if (dbUrl === undefined) fail("CONFIG_MISSING_REQUIRED", "database.url");
  if (!/^postgres(ql)?:\/\//.test(dbUrl as string)) {
    fail("CONFIG_INVALID_VALUE", "database.url");
  }

  if (isProduction) {
    requireProdString(input, "auth.secret", 32);
    requireProdString(input, "auth.base_url");
  }

  // SMTP enable-pair (host+from) and credential-pair (user+password).
  requireGroup(input, ["email.smtp.host", "email.smtp.from"]);
  requireGroup(input, ["email.smtp.user", "email.smtp.password"]);
  if (isProduction && values.get("email.smtp.secure") === "none") {
    fail("CONFIG_INVALID_VALUE", "email.smtp.secure");
  }

  // OAuth provider pairs: one credential alone fails at startup (the old
  // warn-and-disable behavior remains only for standalone helper calls).
  for (const id of ["google", "discord", "github"] as const) {
    requireGroup(input, [`auth.oauth.${id}.client_id`, `auth.oauth.${id}.client_secret`]);
  }

  // payOS triple: any member implies all three.
  requireGroup(input, [
    "payments.payos.client_id",
    "payments.payos.api_key",
    "payments.payos.checksum_key",
  ]);

  // Turnstile: a secret key without its site key is a deployment mistake.
  if (values.has("captcha.turnstile.secret_key") && !values.has("captcha.turnstile.site_key")) {
    fail("CONFIG_MISSING_REQUIRED", "captcha.turnstile.site_key");
  }
};
