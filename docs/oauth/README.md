# OAuth sign-in (Google / Discord / GitHub)

Server-side social sign-in via Better Auth's built-in providers
(`apps/api/src/auth.ts`, `apps/api/src/oauth-config.ts`). No new tables: OAuth
identities are stored in the existing `account` table (`provider_id`,
`account_id`).

Per-provider setup guides:

- [Google](google.md) — Google Cloud Console OAuth client
- [Discord](discord.md) — Discord Developer Portal application
- [GitHub](github.md) — GitHub OAuth App

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
  `../ops/configuration.md`). Precedence per field: explicit environment
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
- Secrets are server-only (`apps/api`); never in `VITE_*`/browser code. Real
  values live in the mounted, untracked config file or deployment env — never
  in Git, Dockerfiles, or the browser bundle.

## Provider console callbacks

Register these redirect URIs in each provider's developer console, using the
public base URL (`BETTER_AUTH_URL` / `HBR_BASE_URL`):

| Provider | Redirect URI (exact)                  | Default scopes                                                                       |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| Google   | `<baseURL>/api/auth/callback/google`  | `openid email profile`                                                               |
| Discord  | `<baseURL>/api/auth/callback/discord` | `identify email`                                                                     |
| GitHub   | `<baseURL>/api/auth/callback/github`  | `read:user user:email` (private/primary email resolved via the provider's email API) |

Must be HTTPS in production (the base URL origin is the only trusted origin
besides explicit `HBR_TRUSTED_ORIGINS`). Scopes are Better Auth built-in
defaults — do not configure scopes manually in the provider console.

`auth.base_url` is validated at startup (`canonicalAuthBaseURL` in
`apps/api/src/auth.ts`): it must be an absolute http(s) origin-only URL. A
trailing slash is stripped and a non-default port is preserved, so register
the portal URI with exactly the origin the instance is configured with (a
port mismatch or an extra path/trailing slash in the portal entry is itself
an `invalid redirect_uri`).

In production the callback origin is always the `auth.base_url` origin
(`https://hoborouter.tretrauit.me`); in local development the API's
`baseURL` (default `http://localhost:3000`) decides the callback, and the
Vite frontend (`:5173`) is a trusted origin, not a callback. Each provider
guide has the exact local setup.

## Account linking policy (security)

- Implicit linking on sign-in follows Better Auth 1.7.6 safe defaults and is
  NOT customized: it happens only when the **provider email is verified AND
  the existing local user row is email-verified**, and the local user is only
  ever found by the provider email itself — a different email can never link
  implicitly and an unverified provider claim can never take over a local one.
- `allowDifferentEmails` is `true` (owner-approved): it widens ONLY the
  explicit `/api/auth/link-social` flow. A signed-in user may link a provider
  identity whose email is DIFFERENT from the local account email when that
  provider email is verified. **Disclosure:** a verified provider identity
  under any email address can therefore be attached to an account; unverified
  provider emails are still refused (`unable_to_link_account`). No
  `trustedProviders` list is configured, so the verified-provider requirement
  always applies.
- Provider email missing → clean failure (`email_not_found`); no placeholder
  addresses are created.
- Provider identity uniqueness is preserved: a provider account already owned
  by another user can never be claimed
  (`account_already_linked_to_different_user`), and unlinking keeps its fresh
  session + last-sign-in-method protections.
- State, PKCE, and replay protections are Better Auth defaults, untouched;
  explicit-link callback URLs are validated against trusted origins.

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
