# Google sign-in setup

Server-side Google sign-in via Better Auth's built-in Google provider. See
[README.md](README.md) for shared configuration rules (env precedence, YAML,
secrets, linking policy).

Primary sources (fetched/official docs; no live console access):

- OAuth 2.0 for Web Server Applications:
  https://developers.google.com/identity/protocols/oauth2/web-server
- OpenID Connect scopes (`openid`, `email`, `profile`):
  https://developers.google.com/identity/openid-connect/openid-connect
- OAuth App Verification: https://support.google.com/cloud/answer/13463073
- Better Auth Google provider: https://better-auth.com/docs/authentication/google
- Console: https://console.cloud.google.com/apis/credentials

Google sign-in uses the web-server authorization code flow with the default
scopes `openid email profile` (Better Auth built-in defaults — do not add
scopes manually). These are non-sensitive scopes, so full app verification is
not required; "brand-verification" is only needed to display app name/logo on
the consent screen. No Google API data scopes are requested.

## Steps

1. Create the client
   1. Google Cloud Console → create/select a project → Google Auth Platform.
   2. **Branding**: app name, homepage, privacy policy; authorized domain
      `tretrauit.me`.
   3. **Audience**: user type External (or Internal if Workspace); publishing
      status Testing initially, add test users. In production status is fine
      for non-sensitive scopes without full verification.
   4. **Data Access**: nothing to add — only `openid email profile`.
   5. **Clients** → **Create OAuth client ID** → **Web application**.
2. Register the redirect
   1. Authorized redirect URI, exactly:
      `https://hoborouter.tretrauit.me/api/auth/callback/google`
   2. `redirect_uri` must exactly match a registered URI, otherwise Google
      returns `redirect_uri_mismatch`. HTTPS required (localhost exempt), no
      fragment, no open-redirect queries.
   3. Authorized JavaScript origins are a separate setting (browser token
      clients) — not needed for this server code flow; add the frontend origin
      only if a browser-side Google component is ever used.
3. Get credentials
   1. Copy the **Client ID** and **Client Secret** from the Clients page.
   2. Only two fields matter — do not paste the downloaded client JSON
      anywhere. Store both server-side only.
4. Configure the server (production YAML, `HBR_CONFIG_FILE`):

   ```yaml
   auth:
     base_url: "https://hoborouter.tretrauit.me" # required in production
     trusted_origins:
       - "https://hoborouter.tretrauit.me"
     secret: "<existing-or-new-32+-char-random-string>"
     oauth:
       google:
         client_id: "<client id>"
         client_secret: "<client secret>"
   ```

   - Equivalent environment variables (`apps/api/src/config/aliases.ts`):
     `HBR_OAUTH_GOOGLE_CLIENT_ID` / `HBR_OAUTH_GOOGLE_CLIENT_SECRET` (mapped
     to `auth.oauth.google.*`). Precedence: explicit env > YAML > default.
     Present-but-empty/invalid env fails at startup — remove the obsolete
     export rather than guessing why YAML is ignored.
   - `auth.base_url` is required in production (startup throws otherwise) and
     decides the callback origin Better Auth sends.
   - Secrets stay server-side: never in Git, `VITE_*`, the browser bundle, or
     Dockerfiles. Keep the real config file untracked (`chmod 600`).

5. Restart and verify
   1. Restart the API process so startup config is re-read (manual operator
      step; no other services).
   2. Login page shows **Continue with Google** only when the complete pair
      is configured (`/api/v1/public-config` booleans only).
   3. Sign in → Google consent screen (name/email/profile) → approve → back
      in the same SPA, logged in.

## Local development

The API's `baseURL` (default `http://localhost:3000`) derives the redirect, so
the Google client needs
`http://localhost:3000/api/auth/callback/google`. The Vite frontend (`:5173`)
is a different origin: add `http://localhost:5173` to `HBR_TRUSTED_ORIGINS` so
browser→API auth calls are accepted — it is NOT a Google redirect URI. Exact
values depend on the deployment's actual `BETTER_AUTH_URL` / `HBR_BASE_URL`.

## Troubleshooting

- `redirect_uri_mismatch` — callback derived from `auth.base_url` isn't an
  exact-string match of a registered URI. Fix `BETTER_AUTH_URL` /
  `HBR_BASE_URL` and register exactly
  `${baseURL}/api/auth/callback/google`.
- 403 `access_denied` / testing access blocked — client is External + Testing
  and the account isn't in the test-users list (Audience section). Or switch
  publishing status to In production (allowed without full verification for
  non-sensitive scopes).
- `invalid_client` at token exchange — wrong client secret; re-copy from the
  Clients page.
- Missing button — partial/missing credential pair (check
  `/api/v1/public-config`).
- `account_not_linked` — unverified Google email claim into a verified local
  account (see linking policy in [README.md](README.md)); implicit linking
  needs a verified provider email.

Live sign-in was not tested (real credentials required).
