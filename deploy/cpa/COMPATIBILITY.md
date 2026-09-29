# CPA compatibility — pinned release

## Pinned release

- Repo: `router-for-me/CLIProxyAPI`
- `tag_name`: **v8.0.4** (fetched live from GitHub releases API `releases/latest`, published `2026-09-29T00:12:47Z`; unauthenticated curl was rate-limited, fetched via authenticated `gh api`)
- Image: `eceasy/cli-proxy-api:v8.0.4` (pinned upstream Compose default repository; pulled digest `sha256:72205ea2dff7e3e3ef23b03de4e17b169ff7449c02b12f2924a3d4d3eee68b7d`). The initial GHCR image `ghcr.io/router-for-me/cliproxyapi:v8.0.4` returned registry `denied`; never started.
- `config.example.yaml` snapshot: `deploy/cpa/config.example.yaml`, byte-identical to the tag's copy
- sha256: `8cd8b1ef85286534b52d93bb3d6e26e62c36cc5c05bac31f540f8692a060402e`

## Rendered config diff vs snapshot

`render-config.sh` changes exactly three fields; everything else is the verbatim example:

| Field (snapshot path)     | Snapshot value                      | Rendered value                                        |
| ------------------------- | ----------------------------------- | ----------------------------------------------------- |
| `management.allow-remote` | `false`                             | `true`                                                |
| `management.secret-key`   | `""`                                | `$CPA_MANAGEMENT_KEY` (64 hex chars, pre-substituted) |
| `access.api-keys`         | 3 example keys `your-api-key-1/2/3` | single entry `$CPA_ACCESS_KEY` (pre-substituted)      |

`server.port` is already `8317` in the snapshot — unchanged. No other field is touched; the render script fails if the diff contains any other line.

Secrets are substituted by the shell before the file reaches CPA. CPA's own config interpolation is not relied upon. Rendered `deploy/cpa/config.yaml` and `deploy/.env` are gitignored (leakage control; confirmed by `git check-ignore`).

## Deployment / isolation status

**Host-isolation PF control UNINSTALLED and UNVERIFIED. No production deployment or paid traffic. No success claim.** Empirical baseline (2026-09-29, OrbStack 29.4.0): `docker compose up -d --wait` succeeded; peer `GET http://cpa:8317/healthz` returned 200; no host port published (`docker port` empty), but the mandatory HOST→bridge-IP probe returned HTTP **200** — `internal: true` does **not** isolate CPA from this host.

Approved design now implemented in repo files (installation is a separate user gate):

- Compose: dedicated conflict-checked subnet `192.168.231.0/24` (host routes + OrbStack default `192.168.215.0/24` checked 2026-09-29), fixed CPA IPv4 `192.168.231.3`, `internal: true`, NO published ports.
- PF rule template `deploy/pf/cpa-host-isolation.conf`: `block drop out log quick to 192.168.231.3` (all ports, host outbound). **UNINSTALLED** — install/rollback commands in `deploy/pf/README.md` and `docs/ops/runbook-foundation.md` are documented for user review only; no repo script or test ever runs sudo, loads, or enables PF.
- `scripts/cpa-preflight.sh` (unprivileged, fail-closed): requires PF enabled, the EXACT rule loaded (`pfctl -s rules` byte-match), and `pfctl -nf` parse (read-only); Permission denied on any check → refuse to start. On gated start: verifies fixed IP, no published ports (inspect-based — `docker compose port` is unreliable: returned exit 0 with `invalid IP:0` despite no published port), peer probe 200, host probe to `192.168.231.3:8317` MUST fail; else teardown + STOP.
- IPv6 is disabled for the stack; an IPv6 deny rule must be added BEFORE IPv6 is ever enabled. Known bypass risk: OrbStack VM routing may evade PF — caught only by the live host probe at start time.

Isolation may be claimed only after: (1) user installs the PF rule via the documented commands, (2) `scripts/cpa-preflight.sh` passes with live probes, and (3) the `host CANNOT reach CPA bridge IP` test in `apps/api/test/cpa-reachability.test.ts` (currently expected-fail/red) flips to passing.

Management route `/v0/management/credentials/status` remains unverified against live v8.0.4.

## Residual risks

- Platform Docker stacks differ; the host firewall rule (once approved) is the explicit compensating control for host→CPA-IP reachability.
- Gateway service in compose is a committed `curlimages/curl` peer placeholder; real gateway image wiring lands with containerization work.
