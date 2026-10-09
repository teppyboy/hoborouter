// OAuth provider env trust boundary (src/oauth-config.ts).
// A provider is enabled ONLY when BOTH its client id and secret are present,
// trimmed and non-empty. Partial/malformed config disables the provider with a
// warning that never contains the secret values.
import { describe, expect, test } from "bun:test";
import { oauthProviderFlags, socialProvidersOption } from "../src/oauth-config";

const IDS = [
  "HBR_OAUTH_GOOGLE_CLIENT_ID",
  "HBR_OAUTH_GOOGLE_CLIENT_SECRET",
  "HBR_OAUTH_DISCORD_CLIENT_ID",
  "HBR_OAUTH_DISCORD_CLIENT_SECRET",
  "HBR_OAUTH_GITHUB_CLIENT_ID",
  "HBR_OAUTH_GITHUB_CLIENT_SECRET",
] as const;

const ENV_ALL = [...IDS] as string[];

// Env is process-global: pin a deterministic state per test and restore.
const withEnv = (values: Partial<Record<string, string | undefined>>, run: () => void) => {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_ALL) {
    saved.set(k, process.env[k]);
    const v = values[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    run();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const captureLogs = (run: () => void): string[] => {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    run();
  } finally {
    console.warn = orig;
  }
  return lines;
};

const SECRET_VALUE = "sekrit-github-value-do-not-log";

describe("oauth-config provider flags", () => {
  test("no env at all: every provider disabled", () =>
    withEnv({}, () => {
      expect(oauthProviderFlags(process.env)).toEqual({
        google: false,
        discord: false,
        github: false,
      });
    }));

  test("both vars set (with surrounding whitespace): enabled", () =>
    withEnv(
      {
        HBR_OAUTH_GITHUB_CLIENT_ID: "  id-123  ",
        HBR_OAUTH_GITHUB_CLIENT_SECRET: SECRET_VALUE,
      },
      () => {
        expect(oauthProviderFlags(process.env)).toEqual({
          google: false,
          discord: false,
          github: true,
        });
      },
    ));

  test("partial config (id only): disabled, warns without secret leak", () =>
    withEnv({ HBR_OAUTH_GITHUB_CLIENT_ID: "id-123" }, () => {
      const lines = captureLogs(() => {
        expect(oauthProviderFlags(process.env).github).toBe(false);
      });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).not.toContain(SECRET_VALUE);
    }));

  test("blank secret counts as missing: disabled", () =>
    withEnv({ HBR_OAUTH_GITHUB_CLIENT_ID: "id-123", HBR_OAUTH_GITHUB_CLIENT_SECRET: "   " }, () => {
      expect(oauthProviderFlags(process.env).github).toBe(false);
    }));

  test("blank id counts as missing: disabled", () =>
    withEnv(
      { HBR_OAUTH_GITHUB_CLIENT_ID: "", HBR_OAUTH_GITHUB_CLIENT_SECRET: SECRET_VALUE },
      () => {
        expect(oauthProviderFlags(process.env).github).toBe(false);
      },
    ));

  test("providers are independent", () =>
    withEnv(
      {
        HBR_OAUTH_GOOGLE_CLIENT_ID: "g-id",
        HBR_OAUTH_GOOGLE_CLIENT_SECRET: "g-secret",
        HBR_OAUTH_DISCORD_CLIENT_ID: "d-id", // secret missing
      },
      () => {
        expect(oauthProviderFlags(process.env)).toEqual({
          google: true,
          discord: false,
          github: false,
        });
      },
    ));
});

describe("oauth-config better-auth option", () => {
  test("unconfigured: empty socialProviders option", () =>
    withEnv({}, () => {
      expect(socialProvidersOption(process.env)).toEqual({});
    }));

  test("configured github: option carries trimmed credentials, never throws", () =>
    withEnv(
      {
        HBR_OAUTH_GITHUB_CLIENT_ID: " gh-id ",
        HBR_OAUTH_GITHUB_CLIENT_SECRET: SECRET_VALUE,
      },
      () => {
        const option = socialProvidersOption(process.env);
        expect(Object.keys(option).sort()).toEqual(["github"]);
        const github = option.github;
        expect(github?.clientId).toBe("gh-id");
        expect(github?.clientSecret).toBe(SECRET_VALUE);
      },
    ));
});
