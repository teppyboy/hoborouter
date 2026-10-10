import { z } from "zod";
import { FIELD_SPECS, SMTP_SECURE_VALUES, type FieldSpec, type SmtpSecure } from "./aliases";

/** Every config leaf resolves to one env-equivalent scalar shape. */
export type ResolvedLeafValue = string | number | boolean | readonly string[];

// Startup configuration errors carry a stable code and a field path ONLY.
// Messages must never contain parser output, file content, values, or secrets.
export type ConfigErrorCode =
  | "CONFIG_MISSING_REQUIRED"
  | "CONFIG_INVALID_VALUE"
  | "CONFIG_FILE_UNREADABLE"
  | "CONFIG_FILE_TOO_LARGE"
  | "CONFIG_UNKNOWN_KEY";

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly path: string;

  constructor(code: ConfigErrorCode, path: string) {
    super(`${code} at ${path}`);
    this.name = "ConfigError";
    this.code = code;
    this.path = path;
  }
}

export const invalid = (path: string): ConfigError => new ConfigError("CONFIG_INVALID_VALUE", path);

// Zod at the trust boundary (AGENTS.md): YAML values are untrusted input.
// Env strings are pre-coerced by the loader before reaching these schemas, so
// the schemas validate the same primitive types YAML provides.
export const leafSchema = (spec: FieldSpec): z.ZodType<ResolvedLeafValue> => {
  switch (spec.kind) {
    case "string":
      return z.string();
    case "int": {
      let s = z.number().int();
      if (spec.min !== undefined) s = s.min(spec.min);
      if (spec.max !== undefined) s = s.max(spec.max);
      return s;
    }
    case "boolean":
      return z.boolean();
    case "stringList":
      return z.array(z.string());
    case "smtpSecure":
      return z.enum(SMTP_SECURE_VALUES);
  }
};

export interface OAuthProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Immutable, grouped startup configuration plus the resolved env map that
 *  existing env-record helpers (oauth-config, payments provider, email,
 *  mock-config, auth) can consume without process.env access. */
export interface ResolvedConfig {
  readonly server: {
    readonly port: number;
    readonly idleTimeoutS: number;
    readonly webDist: string;
    readonly avatarDir: string;
    readonly trustProxy?: boolean;
  };
  readonly database: { readonly url: string };
  readonly auth: {
    readonly secret?: string;
    readonly baseUrl: string;
    readonly trustedOrigins: readonly string[];
  };
  readonly oauth: {
    readonly google?: OAuthProviderConfig;
    readonly discord?: OAuthProviderConfig;
    readonly github?: OAuthProviderConfig;
  };
  readonly bootstrap: { readonly instanceAdminEmail?: string; readonly devAdminEmail?: string };
  readonly email: {
    readonly smtp: {
      readonly host?: string;
      readonly from?: string;
      readonly port?: number;
      readonly secure?: SmtpSecure;
      readonly user?: string;
      readonly password?: string;
    };
  };
  readonly captcha: {
    readonly turnstile: { readonly siteKey?: string; readonly secretKey?: string };
  };
  readonly cpa: {
    readonly baseUrl: string;
    readonly accessKey?: string;
    readonly managementKey?: string;
  };
  readonly gateway: {
    readonly enabled: boolean;
    /** Absent = no Hoborouter-imposed output default (unlimited). */
    readonly defaultMaxOutputTokens?: number;
    readonly upstreamHeadersTimeoutMs: number;
  };
  readonly billing: { readonly usdVndRate: number };
  readonly payments: {
    readonly payos: {
      readonly clientId?: string;
      readonly apiKey?: string;
      readonly checksumKey?: string;
    };
    readonly mock: { readonly enabled: boolean; readonly webhookKey?: string };
  };
  /** Resolved env-equivalent record (canonical alias per field, stringified).
   *  Optional fields absent from the merged config are omitted. */
  readonly env: Readonly<Record<string, string>>;
}

export const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
};

/** Number of leaf fields in FIELD_SPECS — exported so tests can assert the
 *  alias inventory stayed intact without reading source files. */
export const FIELD_COUNT = FIELD_SPECS.length;
