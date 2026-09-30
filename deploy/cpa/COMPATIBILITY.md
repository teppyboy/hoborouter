# CPA compatibility — pinned release

## Pinned release

- Repo: `router-for-me/CLIProxyAPI`
- `tag_name`: **v8.0.4** (fetched live from GitHub releases API `releases/latest`, published `2026-09-29T00:12:47Z`; unauthenticated curl was rate-limited, fetched via authenticated `gh api`)
- Image: `eceasy/cli-proxy-api:v8.0.4` (pinned upstream Compose default repository; pulled digest `sha256:72205ea2dff7e3e3ef23b03de4e17b169ff7449c02b12f2924a3d4d3eee68b7d`). The initial GHCR image `ghcr.io/router-for-me/cliproxyapi:v8.0.4` returned registry `denied`; never started.
- `config.example.yaml` snapshot: `deploy/cpa/config.example.yaml`, byte-identical to the tag's copy
- sha256: `8cd8b1ef85286534b52d93bb3d6e26e62c36cc5c05bac31f540f8692a060402e`

## Rendered config diff vs snapshot

`render-config.sh` changes exactly three fields; everything else is the verbatim example:

| Field (snapshot path)     | Snapshot value                                                       | Rendered value                                        |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| `management.allow-remote` | `false`                                                              | `true`                                                |
| `management.secret-key`   | `""`                                                                 | `$CPA_MANAGEMENT_KEY` (64 hex chars, pre-substituted) |
| `access.api-keys`         | 3 placeholder example keys (redacted here; verbatim in the snapshot) | single entry `$CPA_ACCESS_KEY` (pre-substituted)      |

`server.port` is already `8317` in the snapshot — unchanged. No other field is touched; the render script fails if the diff contains any other line.

Secrets are substituted by the shell before the file reaches CPA. CPA's own config interpolation is not relied upon. Rendered `deploy/cpa/config.yaml` and `deploy/.env` are gitignored (leakage control; confirmed by `git check-ignore`).

## Local deployment

CPA runs on `127.0.0.1:8317` with a generated 256-bit management key. Use `scripts/cpa-dev.sh up|down|status`; paid AI traffic remains disabled.

## Residual risks

- Loopback-only binding plus 256-bit keys are the controls for this single-owner host.
- Gateway service in compose is a committed `curlimages/curl` peer placeholder; real gateway image wiring lands with containerization work.
