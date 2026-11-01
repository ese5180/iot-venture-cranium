#!/usr/bin/env bash
#
# Fail if a tracked file holds a private key, or if a wifi_secrets.h is tracked. The repository is
# public, and a commit that has been pushed cannot be taken back. Run by the workflow on every push:
#
#   scripts/scan-tracked-files.sh
#
# .gitignore is the first guard, and this one catches what got past it with git add -f or under
# another name. It looks at the files of the commit that is checked out, not at older commits. It
# prints file names only, because the logs of a public repository are public too.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

status=0

# A scan that looks at nothing must not pass.
count=$(git ls-files | wc -l | tr -d ' ')
if [ "$count" = 0 ]; then
  echo "error: git lists no tracked files here" >&2
  exit 1
fi

# -a: a key inside a binary file counts as well. git grep exits 1 for no match and above that for a failure.
found=0
keys=$(git grep -a -l -E -e '-----BEGIN [A-Z0-9 ]*PRIVATE KEY') || found=$?
if [ "$found" -gt 1 ]; then
  echo "error: git grep failed" >&2
  exit 1
fi
if [ -n "$keys" ]; then
  printf 'error: these tracked files hold a private key:\n%s\n' "$keys" >&2
  status=1
fi

wifi=$(git ls-files | grep -E '(^|/)wifi_secrets\.h$' || true)
if [ -n "$wifi" ]; then
  printf 'error: a file with Wi-Fi credentials is tracked:\n%s\n' "$wifi" >&2
  status=1
fi

if [ "$status" = 0 ]; then
  echo "ok: $count tracked files, with no private key and no wifi_secrets.h"
else
  echo "Anything pushed stays reachable on GitHub by its commit id. Treat a key or a password that was pushed as exposed, and replace it." >&2
fi
exit "$status"
