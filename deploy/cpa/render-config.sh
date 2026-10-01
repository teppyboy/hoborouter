#!/bin/sh
# Render from the byte-identical pinned example. Never print secret-bearing diffs.
set -eu
umask 077

DIR=$(cd "$(dirname "$0")" && pwd)
SRC="$DIR/config.example.yaml"
OUT="$DIR/config.yaml"
TMP="$OUT.tmp.$$"
trap 'rm -f "$TMP"' EXIT HUP INT TERM

: "${CPA_MANAGEMENT_KEY:?CPA_MANAGEMENT_KEY must be set}"
: "${CPA_ACCESS_KEY:?CPA_ACCESS_KEY must be set}"
for v in "$CPA_MANAGEMENT_KEY" "$CPA_ACCESS_KEY"; do
  case "$v" in *[!0-9a-f]*) echo 'refusing: secret must be lowercase hex' >&2; exit 1 ;; esac
  [ ${#v} -eq 64 ] || { echo 'refusing: secret must be 64 hex chars' >&2; exit 1; }
done

EXPECTED_SHA=8cd8b1ef85286534b52d93bb3d6e26e62c36cc5c05bac31f540f8692a060402e
ACTUAL_SHA=$(openssl dgst -sha256 -r "$SRC" | cut -d ' ' -f1)
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || { echo 'refusing: pinned snapshot changed' >&2; exit 1; }
[ "$(grep -c '^  allow-remote: false$' "$SRC")" = 1 ] &&
[ "$(grep -c '^  secret-key: ""$' "$SRC")" = 1 ] &&
[ "$(grep -c '^    - "your-api-key-[123]"$' "$SRC")" = 3 ] &&
grep -q '^  port: 8317$' "$SRC" || {
  echo 'refusing: pinned config shape changed' >&2
  exit 1
}

sed -e 's/^  allow-remote: false$/  allow-remote: true/' \
    -e "s/^  secret-key: \"\"$/  secret-key: \"$CPA_MANAGEMENT_KEY\"/" \
    -e 's/^    - "your-api-key-1"$/    - "'"$CPA_ACCESS_KEY"'"/' \
    -e '/^    - "your-api-key-2"$/d' \
    -e '/^    - "your-api-key-3"$/d' "$SRC" > "$TMP"
[ "$(grep -c '^  allow-remote: true$' "$TMP")" = 1 ] &&
[ "$(grep -c "^  secret-key: \"$CPA_MANAGEMENT_KEY\"\$" "$TMP")" = 1 ] &&
[ "$(grep -c "^    - \"$CPA_ACCESS_KEY\"\$" "$TMP")" = 1 ] &&
! grep -q '^    - "your-api-key-' "$TMP" || {
  echo 'render failed: unexpected output shape' >&2
  exit 1
}
mv -f "$TMP" "$OUT"
echo 'wrote deploy/cpa/config.yaml (values not printed)'
