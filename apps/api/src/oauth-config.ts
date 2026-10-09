import { z } from "zod";

// OAuth provider credentials at the env trust boundary. Server-only: these
// values feed the Better Auth server config and must never reach the client
// bundle, the public-config response, or logs.
//
// A provider is enabled ONLY when BOTH its client id and client secret are
// present, trimmed and non-empty. Partial or malformed config disables that
// provider alone (never the whole app) with a warning that names the missing
// variable but never echoes a secret value. Email/password + captcha stay
// independent of OAuth misconfiguration.
export type SocialProviderId = "google" | "discord" | "github";

export interface OAuthProviderCredentials {
  clientId: string;
  clientSecret: string;
}

const PROVIDER_IDS: readonly SocialProviderId[] = ["google", "discord", "github"];

type OAuthEnv = Record<string, string | undefined>;

// Zod at the env trust boundary (AGENTS.md): raw process.env strings are
// untrusted input; the schemas trim and require non-empty values so blank or
// whitespace-only credentials can never count as configured.
const credentialSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v.length > 0, "empty credential");
const providerCredentialsSchema = z.object({
  clientId: credentialSchema,
  clientSecret: credentialSchema,
});

/** Trimmed non-empty string, or null (blank/whitespace counts as missing). */
const credential = (raw: string | undefined): string | null => {
  const parsed = credentialSchema.safeParse(raw ?? "");
  return parsed.success ? parsed.data : null;
};

/** Read + validate provider credentials; enabled providers only. Callers pass
 *  `process.env` (or an isolated record in tests) — no implicit global here.
 *  Each enabled entry passes providerCredentialsSchema (both credentials
 *  trimmed, non-empty). */
export function readOAuthCredentials(
  env: OAuthEnv,
): Partial<Record<SocialProviderId, OAuthProviderCredentials>> {
  const enabled: Partial<Record<SocialProviderId, OAuthProviderCredentials>> = {};
  for (const id of PROVIDER_IDS) {
    const suffix = id.toUpperCase();
    const clientId = credential(env[`HBR_OAUTH_${suffix}_CLIENT_ID`]);
    const clientSecret = credential(env[`HBR_OAUTH_${suffix}_CLIENT_SECRET`]);
    if (clientId && clientSecret) {
      enabled[id] = providerCredentialsSchema.parse({ clientId, clientSecret });
    } else if (clientId || clientSecret) {
      // Partial config is a deployment mistake, not a crash: disable just this
      // provider and point at the missing variable. Values are never logged.
      console.warn(
        `[oauth] ${id} is partially configured (missing HBR_OAUTH_${suffix}_${
          clientId ? "CLIENT_SECRET" : "CLIENT_ID"
        }); ${id} sign-in is disabled. Set both variables to enable it.`,
      );
    }
  }
  return enabled;
}

/** Public-config truth: enabled ONLY when both credentials are configured. */
export function oauthProviderFlags(env: OAuthEnv): Record<SocialProviderId, boolean> {
  const creds = readOAuthCredentials(env);
  return {
    google: !!creds.google,
    discord: !!creds.discord,
    github: !!creds.github,
  };
}

/** Better Auth `socialProviders` option: only fully configured providers. */
export function socialProvidersOption(
  env: OAuthEnv,
): Partial<Record<SocialProviderId, OAuthProviderCredentials>> {
  return readOAuthCredentials(env);
}
