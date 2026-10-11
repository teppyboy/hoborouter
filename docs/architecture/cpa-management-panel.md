# Restricted, pinned CPA panel

Only `/api/v1/admin/cpa/panel/management.html` delivers the reviewed official
MIT management-center v1.22.18 asset. Source SHA256:
`f11e7f970ed474d262049b236c54f35ef59f4b9a2da5b9fe1946af14a8641553`.
No dynamic CPA HTML, auto-update, raw management wildcard extension, New API
or AGPL code. Existing first-party controls and raw-panel denial remain.

The HTTP response applies `sandbox allow-scripts` plus exact inline-script
hashes, `connect-src 'none'`, no workers/frames/forms/objects, no-referrer and
nosniff. The parent must additionally use iframe `sandbox="allow-scripts"`
without same-origin. Top-level asset delivery remains sandboxed. Admin origin
comes from Better Auth's configured base URL, never request Host. Asset,
bootstrap and MIT license hashes are verified before delivery. Docker includes
the asset directory. Origin-specific transformed HTML SHA is returned as
`x-hbr-panel-sha256`; executable CSP hashes cover its actual bytes.

Bootstrap runs before the upstream module. Native XHR unavailable; fetch has
no native fallback. Independent ephemeral storage contains only a placeholder
key, capped at 64 KiB. Exact fakepanel.invalid legacy paths map to fixed
operations; unsupported requests return `HBR_PANEL_UNSUPPORTED`. Messages use
version 1, current UUID channel, exact parent source/configured origin, bounded
IDs/body and 32 pending requests. No session/CSRF/approval credential enters
the frame. Parent must enforce source/opaque origin/channel/generation,
trusted confirmation and one mutation dialog independently.

## API protocol

All endpoints require live session and instance-admin authorization. POSTs
require exact configured Origin, JSON, session-bound CSRF and strict operation
schemas. All responses use no-store.

- GET `session`: parent-only CSRF token, expires after 30 minutes.
- POST `read`: safe config, auth-file list, OAuth aliases or exclusions.
- POST `prepare`: canonical status/delete/alias/exclusion proposal; zero
  upstream calls. Bounded process-local approvals expire after 60 seconds.
- POST `execute`: approval ID only; session binding, synchronous consumption
  before availability checks/dispatch, no replay, no retries. Process restart
  invalidates approvals. Concurrent attempts dispatch at most once.

Upstream requests reconstruct fixed paths/bodies, inject server-only key,
reject redirects, enforce 3s read/15s mutation timeout and 64 KiB JSON bounds.
DTO projection precedes recursive configured-secret checks on parsed strings
and keys, including quotes/backslashes. Raw upstream errors/headers never
return. Mutations require a successful stock acknowledgement; partial deletion
fails safely. Audit contains actor, fixed operation/path, status and latency,
never response/config/secret bodies. Unknown execution results require refresh.

Supported: named auth-file status/delete, OAuth alias/exclusion replace/clear.
Blocked: YAML, provider/client keys, upload/download/details/refresh, OAuth
login, quota/API-call, logs, plugins, model discovery and arbitrary network.
First-party config controls remain available.

## Release gates

Backend behavior tests cover isolation headers, exact script hashes, auth,
CSRF/origin/schema, projection, replay/concurrency, expiry, upstream failures,
secret escaping, partial deletion and existing wildcard denial. Fake browser
integration and production Docker build remain integration-owner gates.
`THIRD_PARTY_NOTICES.md` records direct tagged dependency inventory; complete
transitive copyright/license notice collection remains required before release.
