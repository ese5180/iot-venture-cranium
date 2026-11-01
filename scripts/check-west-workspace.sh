#!/usr/bin/env bash
#
# Say whether a west workspace is exactly the SDK it should be, for the firmware job in
# .github/workflows/ci.yml, which may have restored the workspace from a cache:
#
#   scripts/check-west-workspace.sh <west workspace> <commit of sdk-nrf>
#
# `west update` puts every project on the revision the manifest names, but it does not touch the
# manifest repository, and it leaves changes to a project's files in place. So a cached workspace
# could build something other than the SDK and still pass. This fails if sdk-nrf is on another commit,
# if a project is not on what `west update` just fetched for it, or if a tracked file has changed.
#
# It only reads.

set -euo pipefail

if [ $# -ne 2 ]; then
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
workspace=$1
want=$2

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

cd "$workspace"
have=$(git --no-optional-locks -C nrf rev-parse HEAD)
[ "$have" = "$want" ] || fail "nrf is on $have and should be on $want. If the SDK moved on purpose, change NCS_COMMIT in the workflow"
[ -z "$(git --no-optional-locks -C nrf status --porcelain --untracked-files=no)" ] || fail "nrf has changed files"

checked=0
while IFS='|' read -r name path; do
  [ "$name" = manifest ] && continue # The manifest repository: nrf, checked above.
  head=$(git --no-optional-locks -C "$path" rev-parse HEAD) || fail "$name is not a git repository"
  fetched=$(git --no-optional-locks -C "$path" rev-parse --verify refs/heads/manifest-rev) || fail "$name has no manifest-rev"
  [ "$head" = "$fetched" ] || fail "$name is on $head and the manifest says $fetched"
  [ -z "$(git --no-optional-locks -C "$path" status --porcelain --untracked-files=no)" ] || fail "$name has changed files"
  checked=$((checked + 1))
done < <(west list --format '{name}|{abspath}')
[ "$checked" -gt 0 ] || fail "west lists no projects"
echo "ok: nrf is on $want and $checked other projects are as the manifest says"
