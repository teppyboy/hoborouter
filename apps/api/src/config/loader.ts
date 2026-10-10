import { readFile } from "node:fs/promises";
import { FIELD_SPECS, SMTP_SECURE_VALUES, type FieldSpec } from "./aliases";
import { validateResolvedConfig } from "./gate";
import {
  ConfigError,
  deepFreeze,
  invalid,
  leafSchema,
  type ResolvedConfig,
  type ResolvedLeafValue,
} from "./schema";

// Startup config loader: optional YAML file + environment, merged per field
// (explicit env > YAML > optional default), validated once after merge.
// This module never mutates process.env and never imports from packages/*.

const CONFIG_FILE_ENV = "HBR_CONFIG_FILE";
const DEFAULT_CONFIG_FILE = "config.yaml";
const MAX_CONFIG_BYTES = 1024 * 1024; // 1 MiB

/** Sentinel: field absent from both env, YAML, and defaults. */
const ABSENT = Symbol("absent");

type ResolvedLeaf = { value: ResolvedLeafValue | typeof ABSENT; explicit: boolean };

export interface LoadConfigOptions {
  /** Environment record to read (defaults to a snapshot of process.env).
   *  Never written to. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const hasOwn = (obj: Record<string, unknown>, key: string): boolean => Object.hasOwn(obj, key);

// --- YAML file handling -------------------------------------------------

const readConfigFile = async (
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> => {
  const explicit = hasOwn(env, CONFIG_FILE_ENV);
  const path = env[CONFIG_FILE_ENV];
  if (explicit && (path === undefined || path === "")) {
    // An explicitly configured (but empty) path is a deployment mistake.
    throw new ConfigError("CONFIG_FILE_UNREADABLE", CONFIG_FILE_ENV);
  }
  const target = path ?? DEFAULT_CONFIG_FILE;
  let content: Buffer;
  try {
    content = await readFile(target);
  } catch {
    if (explicit) throw new ConfigError("CONFIG_FILE_UNREADABLE", CONFIG_FILE_ENV);
    return null; // default file absent = env-only deployment
  }
  if (content.byteLength > MAX_CONFIG_BYTES) {
    throw new ConfigError(
      "CONFIG_FILE_TOO_LARGE",
      DEFAULT_CONFIG_FILE === target ? "(file)" : CONFIG_FILE_ENV,
    );
  }
  return content.toString("utf8");
};

// --- YAML tree handling -------------------------------------------------

type YamlNode = Record<string, unknown>;

const parseYamlTree = (content: string): YamlNode => {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(content);
  } catch {
    // Parser output may embed file content; only a path + code survive.
    throw new ConfigError("CONFIG_INVALID_VALUE", "(root)");
  }
  if (
    parsed === null ||
    parsed === undefined ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new ConfigError("CONFIG_INVALID_VALUE", "(root)");
  }
  return parsed as YamlNode;
};

/** Nested map of known YAML keys derived from FIELD_SPECS paths. A node is
 *  either a leaf field or a group with children. */
type KnownNode = { readonly leaf: true } | { readonly leaf: false; readonly children: KnownTree };
type KnownTree = Map<string, KnownNode>;

const LEAF_NODE: KnownNode = { leaf: true };

const buildKnownTree = (): KnownTree => {
  const root: KnownTree = new Map();
  for (const spec of FIELD_SPECS) {
    const segments = spec.path.split(".");
    let level = root;
    for (const segment of segments.slice(0, -1)) {
      const existing = level.get(segment);
      if (existing === undefined) {
        const created: KnownNode = { leaf: false, children: new Map() };
        level.set(segment, created);
        level = created.children;
      } else if (!existing.leaf) {
        level = existing.children;
      } else {
        // A FIELD_SPECS path would have to be both a leaf and a group
        // prefix; that is an authoring bug, not a runtime condition.
        throw new Error(`invalid FIELD_SPECS: ${spec.path} is both leaf and group`);
      }
    }
    level.set(segments[segments.length - 1]!, LEAF_NODE);
  }
  return root;
};

const rejectUnknownKeys = (node: YamlNode, known: KnownTree, prefix: string): void => {
  for (const key of Object.keys(node)) {
    const child = known.get(key);
    if (child === undefined) {
      // The unknown key itself is attacker-controlled text (it can be a
      // pasted secret) — NEVER echo it. Report the known safe parent prefix
      // plus a fixed redacted segment; the message is bounded by length.
      throw new ConfigError(
        "CONFIG_UNKNOWN_KEY",
        prefix === "" ? "[redacted-key]" : `${prefix}.[redacted-key]`,
      );
    }
    if (child.leaf) continue;
    const value = node[key];
    // Interior group: walk when it is a plain object. A scalar placed at a
    // group path fails later at its leaf fields. The recursion prefix only
    // ever accumulates KNOWN (validated) segments — safe to echo.
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const knownPath = prefix === "" ? key : `${prefix}.${key}`;
      rejectUnknownKeys(value as YamlNode, child.children, knownPath);
    }
  }
};

const yamlLeaf = (tree: YamlNode, path: string): { present: boolean; value: unknown } => {
  const segments = path.split(".");
  let node: unknown = tree;
  for (const segment of segments) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return { present: false, value: undefined };
    }
    if (!hasOwn(node as YamlNode, segment)) return { present: false, value: undefined };
    node = (node as YamlNode)[segment];
  }
  return { present: true, value: node };
};

// --- Per-field resolution ----------------------------------------------

const coerceEnvValue = (spec: FieldSpec, raw: string, path: string): ResolvedLeafValue => {
  if (raw === "") throw invalid(path); // present-but-empty = present-invalid
  switch (spec.kind) {
    case "string":
      return raw;
    case "int": {
      if (!/^[+-]?\d+$/.test(raw)) throw invalid(path);
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) throw invalid(path);
      return n;
    }
    case "boolean":
      // Legacy tokens keep the old consumer semantics: e.g. the gateway only
      // ever disabled on env "0" and mock payments only on "off". Fields
      // without declared tokens stay strict "true"/"false" (e.g.
      // HBR_TRUST_PROXY only ever trusted the literal "true").
      if (spec.booleanTokens) {
        if (spec.booleanTokens.truthy.includes(raw)) return true;
        if (spec.booleanTokens.falsy.includes(raw)) return false;
        throw invalid(path);
      }
      if (raw !== "true" && raw !== "false") throw invalid(path);
      return raw === "true";
    case "stringList":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    case "smtpSecure":
      if (!(SMTP_SECURE_VALUES as readonly string[]).includes(raw)) throw invalid(path);
      return raw;
  }
};

/** Validate one resolved leaf. Zod failure output can embed the offending
 *  value, so it is converted to a path+code error and never rethrown raw. */
const parseLeaf = (spec: FieldSpec, value: ResolvedLeafValue): ResolvedLeafValue => {
  const result = leafSchema(spec).safeParse(value);
  if (!result.success) throw invalid(spec.path);
  return result.data;
};

const resolveField = (
  spec: FieldSpec,
  env: Readonly<Record<string, string | undefined>>,
  tree: YamlNode,
): ResolvedLeaf => {
  // Canonical alias first, even when empty: the first present alias wins and
  // must be valid — no fallthrough to secondary aliases or YAML.
  const alias = spec.env.find((k) => hasOwn(env, k));
  if (alias !== undefined) {
    const raw = env[alias];
    if (typeof raw !== "string") throw invalid(spec.path);
    return { value: parseLeaf(spec, coerceEnvValue(spec, raw, spec.path)), explicit: true };
  }
  const fromYaml = yamlLeaf(tree, spec.path);
  if (fromYaml.present) {
    // YAML null/absent-value is invalid rather than a default.
    if (fromYaml.value === null || fromYaml.value === undefined) throw invalid(spec.path);
    return { value: parseLeaf(spec, fromYaml.value as ResolvedLeafValue), explicit: true };
  }
  if (spec.default !== undefined) return { value: spec.default, explicit: false };
  return { value: ABSENT, explicit: false };
};

// --- Env map for existing env-record helpers ----------------------------

const canonicalAlias = (spec: FieldSpec): string => spec.env[0]!;

const envMapValue = (spec: FieldSpec, value: unknown): string => {
  // Booleans serialize back to the EXACT format each old consumer checks
  // (gateway "1"/"0", mock "on"/"off"); everything else keeps the generic
  // env-equivalent form.
  if (typeof value === "boolean") {
    if (spec.booleanTokens) return value ? spec.booleanTokens.out[0] : spec.booleanTokens.out[1];
    return value ? "true" : "false";
  }
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.join(",");
  return String(value);
};

// --- Public entry point --------------------------------------------------

export const loadConfig = async (options: LoadConfigOptions = {}): Promise<ResolvedConfig> => {
  const env = options.env ?? { ...process.env };
  const content = await readConfigFile(env);
  const tree = content === null ? {} : parseYamlTree(content);
  if (content !== null) rejectUnknownKeys(tree, buildKnownTree(), "");

  const resolved = new Map<string, ResolvedLeaf>();
  for (const spec of FIELD_SPECS) {
    resolved.set(spec.path, resolveField(spec, env, tree));
  }

  const values = new Map<string, ResolvedLeafValue>();
  const explicit = new Set<string>();
  for (const [path, leaf] of resolved) {
    if (leaf.value !== ABSENT) {
      values.set(path, leaf.value);
      if (leaf.explicit) explicit.add(path);
    }
  }

  validateResolvedConfig({ values, explicit, nodeEnv: env.NODE_ENV });

  const get = (path: string): ResolvedLeafValue | undefined => values.get(path);
  const opt = (path: string): string | undefined => {
    const v = get(path);
    return typeof v === "string" ? v : undefined;
  };

  const oauthProvider = (id: string) => {
    const clientId = opt(`auth.oauth.${id}.client_id`);
    const clientSecret = opt(`auth.oauth.${id}.client_secret`);
    return clientId !== undefined && clientSecret !== undefined
      ? { clientId, clientSecret }
      : undefined;
  };

  const envMap: Record<string, string> = {};
  for (const spec of FIELD_SPECS) {
    const leaf = resolved.get(spec.path)!;
    if (leaf.value !== ABSENT) envMap[canonicalAlias(spec)] = envMapValue(spec, leaf.value);
  }

  return deepFreeze({
    server: {
      port: get("server.port") as number,
      idleTimeoutS: get("server.idle_timeout_s") as number,
      webDist: get("server.web_dist") as string,
      avatarDir: get("server.avatar_dir") as string,
      trustProxy: (() => {
        const v = get("server.trust_proxy");
        return typeof v === "boolean" ? v : undefined;
      })(),
    },
    database: { url: get("database.url") as string },
    auth: {
      secret: opt("auth.secret"),
      baseUrl: get("auth.base_url") as string,
      trustedOrigins: get("auth.trusted_origins") as string[],
    },
    oauth: {
      google: oauthProvider("google"),
      discord: oauthProvider("discord"),
      github: oauthProvider("github"),
    },
    bootstrap: {
      instanceAdminEmail: opt("bootstrap.instance_admin_email"),
      devAdminEmail: opt("bootstrap.dev_admin_email"),
    },
    email: {
      smtp: {
        host: opt("email.smtp.host"),
        from: opt("email.smtp.from"),
        port: (() => {
          const v = get("email.smtp.port");
          return typeof v === "number" ? v : undefined;
        })(),
        secure: (() => {
          const v = get("email.smtp.secure");
          return v === "starttls" || v === "ssl" || v === "none" ? v : undefined;
        })(),
        user: opt("email.smtp.user"),
        password: opt("email.smtp.password"),
      },
    },
    captcha: {
      turnstile: {
        siteKey: opt("captcha.turnstile.site_key"),
        secretKey: opt("captcha.turnstile.secret_key"),
      },
    },
    cpa: {
      baseUrl: get("cpa.base_url") as string,
      accessKey: opt("cpa.access_key"),
      managementKey: opt("cpa.management_key"),
    },
    gateway: {
      enabled: get("gateway.enabled") as boolean,
      defaultMaxOutputTokens: get("gateway.default_max_output_tokens") as number,
      upstreamHeadersTimeoutMs: get("gateway.upstream_headers_timeout_ms") as number,
    },
    billing: { usdVndRate: get("billing.usd_vnd_rate") as number },
    payments: {
      payos: {
        clientId: opt("payments.payos.client_id"),
        apiKey: opt("payments.payos.api_key"),
        checksumKey: opt("payments.payos.checksum_key"),
      },
      mock: {
        enabled: get("payments.mock.enabled") as boolean,
        webhookKey: opt("payments.mock.webhook_key"),
      },
    },
    env: envMap,
  });
};
