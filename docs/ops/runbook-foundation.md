# Runbook — foundation ops (CPA host isolation)

Status of Task 5 host isolation on this host (macOS 27, OrbStack 29.4.0):
**PF rule UNINSTALLED, isolation UNVERIFIED. No success claim.** Do not run
production or paid traffic through CPA until the manual install below is done
and the live re-probe passes.

## Topology

- CPA pinned `eceasy/cli-proxy-api:v8.0.4`, mount `/CLIProxyAPI/config.yaml`.
- Compose network `cpa-net`: `internal: true`, NO published ports, dedicated
  subnet `192.168.231.0/24` (conflict-checked 2026-09-29 against host routes
  and OrbStack default `192.168.215.0/24`), fixed CPA IP `192.168.231.3`.
- `internal: true` alone is NOT host isolation on OrbStack: the host reached
  the old bridge IP directly (HTTP 200). The host PF rule is required.

## PF control (USER-APPROVED DESIGN; USER-RUN INSTALL)

Rule template: `deploy/pf/cpa-host-isolation.conf`
Exact required line: `block drop out log quick to 192.168.231.3`

Full install/rollback commands: `deploy/pf/README.md`. Summary:

- Install: back up `/etc/pf.conf`, insert `anchor "cpa-host-isolation"` +
  `load anchor ...` NEAR THE TOP (right after the Apple anchor lines — PF is
  first-match; an earlier quick pass would shadow the anchor), `sudo pfctl
-nf /etc/pf.conf` to validate, `sudo pfctl -e` (if needed),
  `sudo pfctl -f /etc/pf.conf`. Full pre-checks and rollback:
  `deploy/pf/README.md`. Note `pfctl -f` replaces the live ruleset — it is a
  real firewall change, not a harmless reload. Do not blind-append (double
  install duplicates lines); do not use `pfctl -d` as generic cleanup.
- Rollback: remove the two anchor lines from `/etc/pf.conf`,
  `sudo pfctl -f /etc/pf.conf`, delete the anchor file. `sudo pfctl -d`
  disables ALL PF rules host-wide — only if PF was enabled solely for this.

## Risks (explicit)

- Rule is IPv4-only because the CPA stack is IPv4-only. IPv6 is DISABLED for
  cpa-net; an IPv6 deny rule MUST be added BEFORE IPv6 is ever enabled.
- OrbStack may route via paths PF does not filter (VM NAT). If it bypasses
  PF, the rule silently stops protecting — hence the mandatory live probe.
- The rule matches by IP; changing the subnet invalidates it.
- Unprivileged `pfctl` reads return Permission denied on stock macOS. The
  preflight must be run with `sudo` (it performs READ-ONLY pfctl queries
  only; it never mutates PF or /etc). It still FAILS CLOSED on any
  verification error.

## Startup procedure (sudo for pfctl reads; fail-closed)

Start CPA only via `scripts/cpa-preflight.sh` — a direct
`docker compose up -f deploy/docker-compose.yml` bypasses the gate (the PF
rule itself remains the control, but isolation is only VERIFIED by the
preflight).

`sudo scripts/cpa-preflight.sh`:

1. `--check-only`: verifies PF enabled, the parent anchor
   `anchor "cpa-host-isolation"` in the MAIN ruleset (`pfctl -s rules`) AND
   the exact child rule inside the anchor (`pfctl -a cpa-host-isolation -s
rules`, whitespace-normalized match — `pfctl -s rules` never shows the
   child), plus the template parse (`pfctl -nf`, read-only). Missing either
   parent or child → exit 2. Never installs or modifies PF.
2. Full run: gates above, subnet-collision pre-check (`netstat -rn` for
   192.168.231.x; a route owned by a Docker network = own/stale, OK; a
   foreign route = refuse; unclassifiable = refuse), then
   `docker compose up -d --wait` (cleanup trap installed BEFORE up — a failed
   up or any failed probe tears the stack down via `down -v`), then verifies
   fixed IP, IPv6 absent, no published ports (`docker inspect` — NOT
   `docker compose port`, which returns exit 0 with 'invalid IP:0' when
   nothing is published), peer probe `http://cpa:8317/healthz` = 200, and
   host probe `http://192.168.231.3:8317/healthz` MUST fail. On SUCCESS the
   cleanup trap is removed and CPA is left RUNNING; on any failure the stack
   is torn down and the script exits 2 (host-probe success prints a STOP
   message).

Privilege separation under sudo: root executes ONLY read-only `pfctl`
queries. `docker`/`curl`/`netstat` run as the invoking user
(`sudo -u "$SUDO_USER"`) so docker uses the user's OrbStack daemon/context,
not root's. The `PFCTL` env var is a test-injection hook for the unit test
suite only — never set it outside tests.

Isolation is verified live per start only. Re-run on every start.

## Test gates

- `apps/api/test/cpa-preflight.test.ts`: fail-closed behaviour (fake pfctl,
  no privileges, no firewall changes), parent+child gate, up-failure cleanup,
  fixed-IP compose assertions.
- `apps/api/test/cpa-reachability.test.ts`: stack-starting tests (including
  `host CANNOT reach CPA bridge IP`) run ONLY with `CPA_PF_INSTALLED=1`
  (normal test — a reachable host FAILS); default suite skips visibly and
  never starts CPA ungated. No `test.failing` masking.

## Local setup and operations

From the repository root:

```sh
bun install
cp deploy/.env.example deploy/.env
bun run dev
```

`deploy/.env` is gitignored. Set these values there as appropriate:

- `HBR_DB_PATH` — SQLite path; defaults to `:memory:`.
- `HBR_WEB_DIST` — web distribution override.
- `HBR_MOCK_PAYMENTS` and `HBR_MOCK_PAYMENTS_WEBHOOK_KEY` — development/demo
  only; mock payments require `HBR_MOCK_PAYMENTS=on`, a non-empty key, and a
  non-production `NODE_ENV`.
- `CPA_MANAGEMENT_KEY` and `CPA_ACCESS_KEY` — CPA credentials.
- `HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL` — optional bootstrap admin email.

### Compose lifecycle and probe rerun

Do not start CPA with a direct Compose command. Use the gated preflight:

```sh
sudo scripts/cpa-preflight.sh
```

The preflight starts the stack, runs peer and host reachability probes, and
leaves CPA running only on success. To run checks without starting it:

```sh
sudo scripts/cpa-preflight.sh --check-only
```

Manual teardown (including failed-run cleanup):

```sh
docker compose -f deploy/docker-compose.yml down -v
```

Re-run the Phase 0 probe after configuration or host-network changes with
`sudo scripts/cpa-preflight.sh`; it must fail closed if PF, the anchor rule,
or the host probe is not verified.

### Verify paid routes remain disabled

```sh
curl -fsS http://localhost:3000/openapi.json | grep -E 'v1/(chat/completions|responses)' && exit 1 || true
curl -i http://localhost:3000/v1/chat/completions
```

The first command must find no paid proxy route. The second must not return a
working paid route (404 is expected). The exact banner is:

> PAID AI TRAFFIC DISABLED — Phase 0 probe does not authorize it; see architecture.md §8 open human decisions.

Mock payment routes are for local development/demo only; never enable them in
production. Docker/Compose reachability and PF host isolation are currently
**UNVERIFIED** on this host until the preflight and live probe pass. No
isolation success claim is made here.
