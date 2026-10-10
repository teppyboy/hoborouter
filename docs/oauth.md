# OAuth sign-in (Google / Discord / GitHub)

Server-side social sign-in via Better Auth's built-in providers
(`apps/api/src/auth.ts`, `apps/api/src/oauth-config.ts`). No new tables: OAuth
identities are stored in the existing `account` table (`provider_id`,
`account_id`).

## Configuration

Set BOTH environment variables for a provider to enable it (values are read at
startup; a restart applies changes). Blank/whitespace values count as missing:
through the startup config loader a present-but-empty value is invalid and
fails at startup (no YAML fallback), while the standalone env-map path simply
leaves the provider disabled (see below).

| Variable                          | Purpose                     |
| --------------------------------- | --------------------------- |
| `HBR_OAUTH_GOOGLE_CLIENT_ID`      | Google OAuth client id      |
| `HBR_OAUTH_GOOGLE_CLIENT_SECRET`  | Google OAuth client secret  |
| `HBR_OAUTH_DISCORD_CLIENT_ID`     | Discord OAuth client id     |
| `HBR_OAUTH_DISCORD_CLIENT_SECRET` | Discord OAuth client secret |
| `HBR_OAUTH_GITHUB_CLIENT_ID`      | GitHub OAuth client id      |
| `HBR_OAUTH_GITHUB_CLIENT_SECRET`  | GitHub OAuth client secret  |

Rules:

- Each provider can alternatively be configured in the startup YAML file
  (`auth.oauth.<provider>.client_id` / `.client_secret`; see
  `docs/ops/configuration.md`). Precedence per field: explicit environment
  variable > YAML > default. Partial credentials are a startup error after
  merge; all-absent keeps the provider disabled.
- A provider is enabled **only** when both of its variables are set. A partial
  pair disables just that provider and logs a warning naming the missing
  variable (values are never logged) when set through the standalone env-map
  path; on the startup config path it fails at startup instead. Email/password sign-in, CAPTCHA, and the
  rest of the app are unaffected by OAuth misconfiguration.
- The client never sees credentials. `/api/v1/public-config` reports only
  `socialProviders: { google, discord, github }` booleans, and a provider is
  `true` only when its complete, valid pair is configured.
- Secrets are server-only (`apps/api`); never in `VITE_*`/browser code.

## Provider console callbacks

Register these redirect URIs in each provider's developer console, using the
public base URL (`BETTER_AUTH_URL` / `HBR_BASE_URL`):

```text
<baseURL>/api/auth/callback/google
<baseURL>/api/auth/callback/discord
<baseURL>/api/auth/callback/github
```

Must be HTTPS in production (the base URL origin is the only trusted origin
besides explicit `HBR_TRUSTED_ORIGINS`). Default scopes: Google
(`openid email profile`), Discord (`identify email`), GitHub
(`read:user user:email` — GitHub private/primary email is resolved through the
provider's email API).

## Account linking policy (security)

- Implicit linking on sign-in follows Better Auth 1.7.6 safe defaults and is
  NOT customized: it happens only when the **provider email is verified AND
  the existing local user row is email-verified**.
- `allowDifferentEmails` stays `false` and no `trustedProviders` list is
  configured — a different provider email can never link into an existing
  account, and an unverified provider claim can never take over a local one.
- Provider email missing → clean failure (`email_not_found`); no placeholder
  addresses are created.
- State, PKCE, and replay protections are Better Auth defaults, untouched.

## Instance-admin bootstrap

`HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL` keeps its existing behavior for
password signups (email match, only while the instance has zero admins). For
OAuth-created users the grant additionally requires the **provider-verified**
email — an unverified provider email matching the bootstrap value is refused
(logged without secrets) and creates an ordinary user.

## Tests

`apps/api/test/oauth-config.test.ts` (env boundary), `oauth-public-config`
flags in `public-config.test.ts`, `oauth-bootstrap.test.ts` (bootstrap gate),
`oauth-linking.test.ts` (linking policy). Provider HTTP endpoints are stubbed
at the fetch layer; no live provider is called. Live sign-in requires real
console credentials configured via the six variables above.
