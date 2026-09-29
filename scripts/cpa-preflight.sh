#!/usr/bin/env bash
# CPA host-isolation preflight + gated start. This script NEVER runs sudo,
# never loads/enables/edits PF, never touches /etc. Fail-closed: if PF
# activation or the EXACT isolation rule cannot be verified (BOTH the parent
# anchor in the main ruleset AND the exact child rule inside the anchor),
# refuses to start.
#
# Privilege separation (macOS Docker-context problem solved here):
# `sudo scripts/cpa-preflight.sh` would otherwise run `docker` as ROOT, which
# uses root's Docker context (/var/run/docker.sock) and CANNOT reach the
# user's OrbStack daemon (user's ~/.docker / ~/.orbstack context). Therefore:
#   - ROOT does ONLY read-only PF queries (pfctl -s info/-s rules/-a .../-nf).
#   - docker, curl and netstat run as the ORIGINAL user (SUDO_USER) via an
#     unprivileged helper, so they use the user's Docker context/daemon.
# The script never sudo's, never writes PF, never touches /etc.
#
# Usage:
#   sudo scripts/cpa-preflight.sh --check-only   # verify PF gate, start nothing
#   sudo scripts/cpa-preflight.sh                # verify, then compose up + probes
#     (on success the stack stays UP; cleanup (down -v) runs only on failure)
#
# PFCTL env var overrides the pfctl binary. TEST-INJECTION HOOK ONLY: the
# unit tests inject a fake pfctl this way. Never set PFCTL outside the test
# suite; under plain `sudo` env_reset strips it anyway, but a deliberately
# forged env (sudo PFCTL=/fake ...) could satisfy the PF gates — the loaded
# PF rule itself, not this script, is the control.
set -u

CPA_IP="192.168.231.3"
SUBNET="192.168.231.0/24"
ANCHOR="cpa-host-isolation"
PARENT_LINE="anchor \"${ANCHOR}\""
RULE="block drop out log quick to ${CPA_IP}"
PFCTL="${PFCTL:-pfctl}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RULE_FILE="$ROOT/deploy/pf/cpa-host-isolation.conf"
COMPOSE=(docker compose -f "$ROOT/deploy/docker-compose.yml")

fail() { echo "FAIL-CLOSED: $*" >&2; [ -n "${T:-}" ] && rm -f "$T"; exit 2; }

# Run a command as the original (non-root) user when invoked via sudo, so
# docker talks to the USER's daemon/context. Direct otherwise.
as_user() {
  if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    sudo -u "$SUDO_USER" -H "$@"
  else
    "$@"
  fi
}

# normalize: strip leading/trailing whitespace per line
norm() { sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$1"; }

# ---- gate 1: PF active ------------------------------------------------
T="$(mktemp)"
"$PFCTL" -s info >"$T" 2>&1 || {
  fail "pfctl -s info failed (Permission denied is normal unprivileged — re-run with sudo). Cannot verify PF is active."
}
grep -q "^Status: Enabled" "$T" || fail "PF is not enabled (Status: $(grep '^Status' "$T" || echo unknown))."
rm -f "$T"; T=""

# ---- gate 2a: parent anchor present in MAIN ruleset --------------------
# `pfctl -s rules` shows only the parent `anchor "cpa-host-isolation"` line;
# the child rule is invisible there (see pfctl(8): nested rulesets).
T="$(mktemp)"
"$PFCTL" -s rules >"$T" 2>&1 || {
  fail "pfctl -s rules failed. Cannot verify the parent anchor is loaded."
}
# Some pfctl versions render the parent anchor with an ` all` suffix;
# accept both shapes (exact line, optionally suffixed).
norm "$T" | grep -Eq "^${PARENT_LINE}( all)?$" || {
  echo "Main ruleset did not contain the parent line: $PARENT_LINE" >&2
  fail "Parent anchor '$ANCHOR' is NOT loaded into the main ruleset. Install per deploy/pf/README.md, then re-run."
}
rm -f "$T"; T=""

# ---- gate 2b: EXACT child rule inside the anchor ------------------------
T="$(mktemp)"
"$PFCTL" -a "$ANCHOR" -s rules >"$T" 2>&1 || {
  fail "pfctl -a $ANCHOR -s rules failed. Cannot verify the anchor's child rules."
}
norm "$T" | grep -Fxq "$RULE" || {
  echo "Anchor '$ANCHOR' rules did not contain the exact required line:" >&2
  echo "  $RULE" >&2
  echo "Anchor actually contains:" >&2
  norm "$T" | sed 's/^/  /' >&2
  fail "CPA host-isolation child rule is NOT loaded (or anchor content drifted). Reinstall per deploy/pf/README.md."
}
rm -f "$T"; T=""

# ---- gate 3: static parse of the template (read-only) ------------------
"$PFCTL" -nf "$RULE_FILE" >/dev/null 2>&1 || {
  fail "pfctl -nf on $RULE_FILE failed (syntax or Permission denied). Refusing: cannot confirm the rule file would parse."
}

# ---- documented bypass risks (informational) ---------------------------
cat >&2 <<EOF
PF gate OK: enabled + parent anchor '$ANCHOR' in main ruleset + exact child
rule '$RULE' inside the anchor; template parses.
Bypass risks acknowledged:
  - Rule is IPv4-only. cpa-net has enable_ipv6: false; add an IPv6 deny
    BEFORE ever enabling IPv6 for the stack.
  - OrbStack routes via its own VM interfaces; if it bypasses PF the live
    host probe below will catch it at every start.
EOF

[ "${1:-}" = "--check-only" ] && { echo "check-only: all PF gates passed; stack not started."; exit 0; }

# ---- subnet collision pre-check (needs docker to classify the route) ----
# A route for 192.168.231.0/24 may be (a) our own / previous Docker network
# (stale or current) — fine, or (b) a foreign host route (VPN etc.) — fatal.
# If ownership cannot be determined, FAIL CLOSED rather than guess.
routes="$(as_user netstat -rn -f inet 2>/dev/null | grep '192\.168\.231\.' || true)"
if [ -n "$routes" ]; then
  nets="$(as_user docker network ls -q 2>/dev/null)" || fail "netstat shows a 192.168.231.x route and docker network listing failed — cannot classify the route; refusing to start."
  [ -n "$nets" ] || fail "netstat shows a 192.168.231.x route but no Docker networks exist — cannot classify; refusing to start."
  owned="$(as_user docker network inspect $nets --format '{{json .IPAM.Config}}' 2>/dev/null | grep -F "$SUBNET" || true)"
  if [ -z "$owned" ]; then
    echo "$routes" >&2
    fail "Host routing table contains a 192.168.231.x route NOT owned by any Docker network (VPN/foreign route?). Subnet collision — refusing to start."
  fi
  echo "note: 192.168.231.0/24 route present but owned by a Docker network (current/previous run); continuing."
fi

# ---- gated start + live probes -----------------------------------------
cleanup() { as_user "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true; }
# trap installed BEFORE up: a failed `up` must not leak a partially-started,
# restart:unless-stopped stack. On SUCCESS the trap is removed below and the
# stack stays running.
trap cleanup EXIT

as_user "${COMPOSE[@]}" up -d --wait --wait-timeout 60 || fail "compose up failed (stack torn down by cleanup trap)."

cid="$(as_user "${COMPOSE[@]}" ps -q cpa)"
[ -n "$cid" ] || fail "cpa container not found after up."
ip="$(as_user docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$cid")"
[ "$ip" = "$CPA_IP" ] || fail "CPA IP is '$ip', expected fixed $CPA_IP."

# IPv6 MUST be absent (enable_ipv6: false is the compose-level guarantee;
# verify live so a future default flip cannot silently open the bypass).
v6="$(as_user docker inspect -f '{{range .NetworkSettings.Networks}}{{.GlobalIPv6Address}}{{end}}' "$cid")"
[ -z "$v6" ] || fail "CPA has an IPv6 address '$v6' — IPv6 must stay disabled for cpa-net."

# published-port guard: definitive inspect-based check only (compose port
# exit code is unreliable — returned 0 with 'invalid IP:0' on this version)
ports="$(as_user docker inspect -f '{{json .NetworkSettings.Ports}}' "$cid")"
echo "$ports" | grep -q ':null' && [ "$(echo "$ports" | tr ',' '\n' | grep -cv ':null')" = "0" ] || {
  [ "$ports" = "{}" ] || fail "CPA appears to have published ports: $ports"
}

# peer probe MUST succeed
peer="$(as_user "${COMPOSE[@]}" exec -T gateway curl -s -m 5 -o /dev/null -w '%{http_code}' "http://cpa:8317/healthz")"
[ "$peer" = "200" ] || fail "peer probe got '$peer', expected 200."

# host probe MUST FAIL (response bodies discarded — never print CPA output)
if as_user curl -s -m 3 -o /dev/null "http://${CPA_IP}:8317/healthz"; then
  fail "STOP: host reached CPA at ${CPA_IP}:8317 — the PF rule is NOT isolating the host (possible OrbStack PF bypass). Do not run CPA exposed; see docs/ops/runbook-foundation.md."
fi

# All probes passed: success path — keep the stack running, remove the
# cleanup trap so EXIT does NOT tear the verified stack down.
trap - EXIT

echo "OK: PF gate + fixed IP + no IPv6 + no published ports + peer 200 + host probe blocked. CPA left RUNNING."
echo "Host isolation verified live for this start only; re-verify on every start."
