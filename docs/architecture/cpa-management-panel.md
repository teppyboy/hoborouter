# CPA `management.html` — investigation verdict and spec blocker

Status: **blocker — raw panel HTML is prohibited; do not proxy, embed, or serve it.**
Scope: hoborouter admin surface (CPA admin routes/UI). CPA pinned release: `v8.0.4`
(see `deploy/cpa/COMPATIBILITY.md`).

## The exact artifact

CLIProxyAPI v8.0.4 serves `GET /management.html` on its own origin (:8317). The
file is **not part of the pinned v8.0.4 binary or its source tree**. CPA
downloads it at runtime from the repo configured in
`management.panel-github-repository` (snapshot value:
`https://github.com/router-for-me/Cli-Proxy-API-Management-Center`), per the
tag's own `config.example.yaml` (snapshot: `deploy/cpa/config.example.yaml`):

- `management.disable-control-panel` — "Disable the bundled management control
  panel asset download and HTTP route when true." Default `false`: the panel is
  downloaded on first access.
- `management.disable-auto-update-panel` — "Disable automatic periodic
  background updates of the management panel from GitHub (default: false)."
  Default `false`: CPA silently re-downloads newer panels from GitHub.

Observed properties of the latest upstream panel release (checked live; the
panel versioning is independent of CPA, currently `v1.26.1` while CPA is pinned
at `v8.0.4`):

- A single ~3.3 MB `management.html` release asset.
- Executable inline code: at least two inline `<script>` blocks, one
  `type="module" crossorigin` (a JS bundle embedded in the HTML), one classic
  script. No `Content-Security-Policy` is present.
- GitHub release metadata for the asset has `immutable: false` — the upstream
  can rewrite any release, so there is no stable hash to pin.

## Why raw HTML under the admin origin is prohibited

1. **Untrusted executable content.** The panel is third-party JavaScript,
   mutable at runtime by CPA's GitHub auto-update, outside the reviewed
   `v8.0.4` source pin. Serving it under the hoborouter admin origin would let
   that code run same-origin with hoborouter admin session cookies (Better
   Auth). That is a supply-chain and session-exposure risk, not a UI choice.
2. **No containment is possible for inline code.** A static
   sanitized/validated asset strategy fails here: the executable payload is
   inline in the HTML (no separate script files to rewrite), the artifact has
   no upstream hash pin, and any vendored copy would be an unauditable 3.3 MB
   blob drifting away from the CPA pin. Sanitization cannot prove a 3.3 MB
   bundle safe, and re-validation on every upstream panel update would require
   trusting the auto-updated artifact again.
3. **Management key exposure.** The panel's auth model is "paste the management
   key into the browser" (see `README.md` and `docs/ops/runbook-foundation.md`).
   Using it from, or serving it under, hoborouter would put
   `CPA_MANAGEMENT_KEY` in browser storage or transit — explicitly forbidden:
   the key must stay server-side only.

## Exact safe alternative (already implemented)

The management surface hoborouter exposes is first-party and server-mediated:

- **Read-only redacted JSON proxy** — `apps/api/src/cpa-management-core.ts`:
  strict allowlist (`GET /v0/management/config`, `GET
/v0/management/usage-queue`), instance-admin gate, deep field-name redaction,
  literal-secret scrubbing, `no-store`, audit per call. Route:
  `/api/v1/admin/cpa/management/*`.
- **Explicit mutation routes** — `apps/api/src/routes/admin-cpa-mutations.ts`:
  every upstream path/method is an allowlist entry; no upstream response body
  is ever proxied to the client; secrets never reach audit or responses.
- **First-party admin UI** — `apps/web/src/pages/admin/cpa.tsx` renders the
  redacted reads and drives the mutation routes. No iframes, no upstream HTML.

`management.html` remains a localhost-only operator tool (open
`http://127.0.0.1:8317/management.html` directly, per the runbook). It is never
proxied, embedded, or re-served by hoborouter, and the CPA management key is
never delivered to any browser.

## Recommended follow-up hardening (out of this lane's scope)

Set `management.disable-control-panel: true` in the rendered CPA config
(`deploy/cpa/render-config.sh`), which removes the panel download/route from
the CPA origin entirely and shrinks CPA's exposed surface. The render script
currently fails on any field outside its three-field allowlist, so the change
must widen that allowlist deliberately in the deploy lane.

## Test anchors

- `apps/api/test/cpa-management-core.test.ts` — allowlist rejects panel/HTML
  asset paths; the proxy wildcard answers a panel path with JSON 404, never
  HTML; redaction and audit invariants.
- `tests/admin-cpa-*.test.tsx` — first-party UI behavior.
