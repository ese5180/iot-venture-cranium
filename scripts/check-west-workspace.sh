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
# if a project is not on what `west update` just fetched for it, if a tracked file has changed, or if
# git has been told not to look at one.
#
# It only reads. This is for a stale or damaged cache: docs/ci.md says why it cannot stop a hostile one.

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

# The configuration of these repositories comes from the cache, and these two settings of it would run
# a program during the check.
git_read() {
  git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
}

# status says nothing about a file marked --skip-worktree or --assume-unchanged, and that mark is in
# the cached index. ls-files -v shows those as S and in lower case.
check_files_of() {
  local name=$1 path=$2 changed listing
  changed=$(git_read -C "$path" status --porcelain --untracked-files=no) || fail "git cannot read $name"
  [ -z "$changed" ] || fail "$name has changed files"
  listing=$(git_read -C "$path" ls-files -v) || fail "git cannot read $name"
  if grep -q '^[a-zS]' <<< "$listing"; then
    fail "$name has files that git was told not to look at"
  fi
}

cd "$workspace"
have=$(git_read -C nrf rev-parse HEAD)
[ "$have" = "$want" ] || fail "nrf is on $have and should be on $want. If the SDK moved on purpose, change NCS_COMMIT in the workflow"
check_files_of nrf nrf

checked=0
while IFS='|' read -r name path; do
  [ "$name" = manifest ] && continue # The manifest repository: nrf, checked above.
  head=$(git_read -C "$path" rev-parse HEAD) || fail "$name is not a git repository"
  fetched=$(git_read -C "$path" rev-parse --verify refs/heads/manifest-rev) || fail "$name has no manifest-rev"
  [ "$head" = "$fetched" ] || fail "$name is on $head and the manifest says $fetched"
  check_files_of "$name" "$path"
  checked=$((checked + 1))
done < <(west list --format '{name}|{abspath}')
[ "$checked" -gt 0 ] || fail "west lists no projects"
echo "ok: nrf is on $want and $checked other projects are as the manifest says"
