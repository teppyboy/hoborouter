# CPA host-isolation PF rule — FOR USER REVIEW ONLY

**Status: UNINSTALLED and UNVERIFIED on this host. Nothing in this repo has
run, loaded, or enabled PF. Host isolation of CPA is NOT yet in effect and
must NOT be claimed.**

`cpa-host-isolation.conf` blocks ALL host outbound traffic (every port) to
the CPA container's fixed IPv4 `192.168.231.3` on the dedicated, conflict-
checked `192.168.231.0/24` cpa-net (internal: true, no published ports).

## Why

Empirically (2026-09-29, OrbStack 29.4.0), `internal: true` did NOT stop the
host from reaching the container bridge IP (HTTP 200). The host firewall rule
is the compensating control.

## Install (USER-RUN; requires sudo; explicit approval gate)

> Read this whole section first. `sudo pfctl -f /etc/pf.conf` REPLACES the
> live ruleset — this is a real host firewall change, not a harmless reload.
> If you are not comfortable with any step, stop; do not install a rule you
> cannot verify.

```sh
# 1. Review the rule: one line, blocks all outbound host traffic to CPA IP
cat deploy/pf/cpa-host-isolation.conf

# 2. Detect conflicting earlier rules BEFORE installing. PF is first-match:
# an earlier `pass quick` covering 192.168.231.3 would shadow this anchor
# depending on placement. Inspect the main ruleset and confirm no earlier
# quick pass rule matches traffic to 192.168.231.3 (or a broader range
# containing it). If you cannot rule this out, STOP — do not install.
sudo pfctl -s rules

# 3. Back up pf.conf (rollback = restore this file)
sudo cp /etc/pf.conf /etc/pf.conf.bak-cpa-$(date +%Y%m%d-%H%M%S)

# 4. Insert the anchor lines NEAR THE TOP of /etc/pf.conf, immediately after
#    the last `anchor "com.apple/..."` line (Apple's anchors are first by
#    convention; ours comes after them but before any user/quick rules).
#    Do NOT blind-append: running an append twice duplicates the lines.
#    Idempotency pre-check first — if either grep hits, the lines already
#    exist and you should skip to step 6:
#      grep -n 'cpa-host-isolation' /etc/pf.conf
#    Then edit /etc/pf.conf manually (sudo vi /etc/pf.conf) and insert:
#      anchor "cpa-host-isolation"
#      load anchor "cpa-host-isolation" from "/etc/pf.anchors/cpa-host-isolation"

# 5. Copy the anchor file (idempotent overwrite; content is pinned in repo)
sudo cp deploy/pf/cpa-host-isolation.conf /etc/pf.anchors/cpa-host-isolation

# 6. Validate the merged config BEFORE loading (must print nothing = OK)
sudo pfctl -nf /etc/pf.conf

# 7. Enable PF if not already enabled, then load
sudo pfctl -e || true   # 'pf already enabled' is fine
sudo pfctl -f /etc/pf.conf
```

If steps 2 or 6 fail or the ordering guarantees above cannot be established
on your pf.conf, DO NOT install. There is no safe generic fallback rule;
file the blocker instead of improvising.

## Rollback (USER-RUN; requires sudo)

```sh
# Preferred: restore the backup taken in step 3, then reload
sudo cp /etc/pf.conf.bak-cpa-<timestamp> /etc/pf.conf
sudo pfctl -f /etc/pf.conf
sudo rm /etc/pf.anchors/cpa-host-isolation
```

Do NOT use `sudo pfctl -d` as generic cleanup: it disables ALL PF on the
host, including Apple's own rules. Only disable PF if you enabled it solely
for this rule and understand the host-wide effect.

## Verify (sudo for pfctl reads — read-only; the script itself never sudo's)

On stock macOS, unprivileged `pfctl` hits `/dev/pf: Permission denied`. The
preflight reads PF state only (never mutates), so run it under sudo:

```sh
sudo scripts/cpa-preflight.sh --check-only   # parent anchor + exact child rule + activation gate
sudo scripts/cpa-preflight.sh                # gated start + live host/peer probes
```

On a FULL successful run the CPA stack is left RUNNING (`docker compose down -v`
runs only when verification fails — a failed `up` or any failed probe tears the
stack down). On some macOS pfctl versions the parent anchor line in
`pfctl -s rules` carries an ` all` suffix; the preflight accepts both shapes.

Note: `pfctl -s rules` shows only the parent `anchor "cpa-host-isolation"`
line, never the child rule. The preflight therefore requires BOTH the parent
anchor in the main ruleset AND the exact child rule via
`pfctl -a cpa-host-isolation -s rules`; missing either = fail-closed.

Privilege separation: under `sudo`, the script runs ONLY read-only `pfctl`
queries as root. `docker`, `curl` and `netstat` run as the invoking user
(via `sudo -u "$SUDO_USER"`), so docker uses YOUR OrbStack context/daemon —
root's Docker context cannot reach it. The script still never mutates PF.

`PFCTL` env var is a TEST-INJECTION hook for the unit tests (fake pfctl via
PATH). Never set it outside the test suite; the loaded PF rule, not this
script, is the control.

## Risks

- Rule is IPv4-only. Keep IPv6 disabled for cpa-net; add an IPv6 deny rule
  BEFORE ever assigning an IPv6 address to the stack.
- OrbStack routes container traffic through its own VM interfaces; if a
  future version bypasses PF, this rule stops protecting silently. The
  preflight live host probe (must fail) catches this at every start.
- Rule match is by IP; if the subnet changes, the rule must change with it.
