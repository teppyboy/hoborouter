# GitHub sign-in setup

Server-side GitHub sign-in via Better Auth's built-in GitHub provider. See
[README.md](README.md) for shared configuration rules (env precedence, YAML,
secrets, linking policy).

Primary sources (official docs; no live console access in this session):

- OAuth Apps overview: https://docs.github.com/en/apps/oauth-apps
- Creating an OAuth App:
  https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app
- Scopes: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- Better Auth GitHub provider: https://www.better-auth.com/docs/authentication/github

This is a classic **OAuth App** (authorization code flow), not a GitHub App
and not a personal access token (PAT). Never use a PAT as the client secret.
Device flow is not used. Scopes `read:user user:email` are Better Auth
built-in defaults — do not add scopes manually; `user:email` grants access to
`/user/emails`, which returns the private/primary verified email even when the
public profile email is hidden.

## Steps

1. Create the app
   1. GitHub → Settings → Developer settings → **OAuth Apps** →
      **New OAuth App** (https://github.com/settings/developers).
   2. Application name: e.g. `Hoborouter`.
   3. Homepage URL: `https://hoborouter.tretrauit.me` (exact, no trailing
      slash).
   4. Authorization callback URL, exactly:
      `https://hoborouter.tretrauit.me/api/auth/callback/github`
      OAuth Apps support exactly **one** callback URL; it must match the
      `redirect_uri` Better Auth sends (derived from `auth.base_url`) —
      protocol, host, path, no trailing slash, no wildcards.
2. Get credentials
   1. **Client ID** is shown immediately after creating the app.
   2. **Generate a new client secret** — shown **once**; copy it immediately.
      "Regenerate" invalidates the old one.
3. Configure the server (production YAML, `HBR_CONFIG_FILE`):

   ```yaml
   auth:
     base_url: "https://hoborouter.tretrauit.me" # decides the callback origin
     trusted_origins:
       - "https://hoborouter.tretrauit.me"
     secret: "<existing-or-new-32+-char-random-string>"
     oauth:
       github:
         client_id: "<client id>"
         client_secret: "<client secret>"
   ```

   - Equivalent environment variables (`apps/api/src/config/aliases.ts`):
     `HBR_OAUTH_GITHUB_CLIENT_ID` / `HBR_OAUTH_GITHUB_CLIENT_SECRET` (mapped
     to `auth.oauth.github.*`). Precedence: explicit env > YAML > default.
     Present-but-empty/invalid env fails at startup — remove the obsolete
     export rather than guessing why YAML is ignored.
   - Secrets stay server-side: never in Git, `VITE_*`, the browser bundle, or
     Dockerfiles. Keep the real config file untracked (`chmod 600`).

4. Restart and verify
   1. Restart the API process so startup config is re-read (manual operator
      step; no other services).
   2. Login page shows **Continue with GitHub** only when the complete pair
      is configured (`/api/v1/public-config` booleans only).
   3. Sign in → GitHub authorize screen (`read:user user:email`) → approve →
      back in the same SPA, logged in.

## Local development

OAuth Apps allow one callback URL, so use a **separate OAuth App** for dev
with callback `http://localhost:3000/api/auth/callback/github` (the API's
`baseURL` decides the origin). Do not register the Vite origin (`:5173`) as a
callback; add `http://localhost:5173` to `HBR_TRUSTED_ORIGINS` for the
frontend instead.

## Troubleshooting

- `redirect_uri mismatch` — callback URL in the portal ≠ `auth.base_url` +
  `/api/auth/callback/github` exactly.
- `client_id` rejected — wrong app, or the ID isn't the OAuth App's Client ID.
- `bad_verification_code` / token error — wrong client secret, or secret was
  regenerated after config; re-copy and restart.
- Private email not visible — `/user/emails` requires the `user:email` scope;
  keep the built-in defaults.
- Missing button — partial/missing credential pair (check
  `/api/v1/public-config`).
- `account_not_linked` — unverified provider email claim into a verified
  local account (see linking policy in [README.md](README.md)).
- Org SSO restrictions — if a user's GitHub org restricts OAuth app access,
  sign-in is blocked GitHub-side for those users only; nothing in Hoborouter
  enforces org policy.

Live sign-in was not tested (real credentials required).
