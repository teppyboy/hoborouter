# Discord sign-in setup

Server-side Discord sign-in via Better Auth's built-in Discord provider. See
[README.md](README.md) for shared configuration rules (env precedence, YAML,
secrets, linking policy).

Primary sources (fetched, not live-tested):

- Discord OAuth2: https://discord.com/developers/docs/topics/oauth2
- Better Auth Discord provider: https://www.better-auth.com/docs/authentication/discord
- Applications portal: https://discord.com/developers/applications

Discord sign-in uses the standard OAuth2 **authorization code grant** with the
`identify email` scopes — no bot, no guild scopes, no bot token, no privileged
intents, and no client credentials grant (client credentials is for
application-owner API access, not user login).

## Steps

1. Create the application
   1. Go to https://discord.com/developers/applications → **New Application**.
   2. Name it (e.g. `Hoborouter`); team ownership is optional.
   3. Open **OAuth2 → General**.
2. Get credentials
   1. Copy the **Client ID** (shown directly on the OAuth2 page).
   2. Click **Reset Secret** to reveal the **Client Secret** (portal labels may
      vary). Copy it once — it is shown only until you leave the page. Treat it
      like a password. Never use a bot token as the client secret.
3. Register the redirect
   1. In **OAuth2 → General → Redirects**, add exactly:
      `https://hoborouter.tretrauit.me/api/auth/callback/discord`
   2. The URI must match exactly — protocol (`https`), host (no `www`, no
      extra subdomain), no trailing slash, no port. Wildcards are not
      supported.
   3. Click **Save Changes**.
4. Configure the server (production YAML, `HBR_CONFIG_FILE`):

   ```yaml
   auth:
     base_url: "https://hoborouter.tretrauit.me"   # decides the callback origin
     trusted_origins:
       - "https://hoborouter.tretrauit.me"
     secret: "<existing-or-new-32+-char-random-string>"
     oauth:
       discord:
         client_id: "<application client id>"
         client_secret: "<client secret>"
   ```

   - Only set the `discord:` pair. Omitting `google:` / `github:` keeps them
     disabled; do not add partial pairs.
   - Equivalent environment variables (`apps/api/src/config/aliases.ts`):
     `HBR_OAUTH_DISCORD_CLIENT_ID` / `HBR_OAUTH_DISCORD_CLIENT_SECRET` (mapped
     to `auth.oauth.discord.*`). Precedence: explicit env > YAML > default.
     If an env var is present but empty/invalid it fails at startup — remove
     the obsolete export instead of guessing why YAML is ignored.
   - Secrets stay server-side: real values go in the mounted config file or
     env, never in Git, the browser bundle, or Dockerfiles. Keep the real
     config file out of version control (`chmod 600`, gitignored).
5. Restart and verify (no re-provisioning needed)
   1. Restart the API process so startup config is re-read (restart only —
      no rebuild of users/sessions data, no other services).
   2. Open the login page: **Continue with Discord** appears only when the
      complete pair is configured (public flags from `/api/v1/public-config`
      expose only booleans, never secrets).
   3. Sign in → Discord consent screen shows `identify` and `email` grants →
      approve → you land back in the same SPA, logged in.

## Local development

`BETTER_AUTH_URL` / `auth.base_url` decides the Discord callback origin. With
the backend on `:3000` register
`http://localhost:3000/api/auth/callback/discord` in the Discord portal and
add `http://localhost:5173` to `trusted_origins` for the Vite frontend. Do not
register `localhost:5173/api/auth/...` unless the API is proxied to match the
auth base URL. Prefer testing against production config to avoid confusing
auth origins.

## Troubleshooting

- `invalid redirect_uri` — URI in portal doesn't exactly match `auth.base_url`
  + `/api/auth/callback/discord`.
- Missing **Continue with Discord** button — stale env or partial pair (check
  `/api/v1/public-config`).
- `token invalid` — wrong client secret, or secret was reset for a different
  application.
- `email_not_found` — Discord returned no email (e.g. phone-only accounts).
- `account_not_linked` — unverified email claim into a verified local account
  (see linking policy in [README.md](README.md)).

Discord CAPTCHA/email settings and password sign-in are unaffected by any of
this. Live sign-in was not tested (real credentials required).
