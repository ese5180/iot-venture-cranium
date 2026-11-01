#!/usr/bin/env bash
#
# Check the files of a published release against the commit it tags. The release-assets job in
# .github/workflows/ci.yml runs this, in a checkout of the tag, after it has downloaded them:
#
#   scripts/verify-github-release.sh <tag> <folder with the release's files>
#
# Fails unless the folder holds the signed image, latest.json and SHA256SUMS and nothing else,
# SHA256SUMS is right, the signature verifies against firmware/keys/fw_signing_pub.pem with the
# console's own check, and the version in the image's header, latest.json and firmware/app/VERSION
# is the one in the tag. It also repeats what scripts/github-release.sh looks for: an image of another
# commit, a test image, a Bluetooth image, the golden image.
#
# It only reads. On a failure it writes a GitHub Actions error annotation as well.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() {
  # The file names of a release can reach a message, so nothing in it may read as a workflow command.
  # To stderr: a check can run in a command substitution, and the runner reads both streams.
  local message
  message=$(printf '%s ' "$@" | tr '\r\n' '  ')
  message=${message//::/: :}
  printf 'error: %s\n' "$message" >&2
  printf '::error title=Release check failed::%s\n' "$message" >&2
  exit 1
}

# shellcheck source=scripts/release-lib.sh
. "$REPO_DIR/scripts/release-lib.sh"

main() {
  if [ $# -ne 2 ]; then
    sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
    exit 2
  fi
  local tag=$1 folder=$2
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(\+[0-9]+)?$ ]] || die "this tag does not look like v1.6.0 or v1.6.0+2"
  [ -d "$folder" ] || die "$folder is not a folder"

  local full file image latest
  full=$(full_version "${tag#v}") || exit 1
  file=$(image_file_name "$full")
  image=$folder/$file
  latest=$folder/latest.json

  local found wanted
  found=$(cd "$folder" && LC_ALL=C ls -A | LC_ALL=C sort)
  wanted=$(printf '%s\n' "$file" latest.json SHA256SUMS | LC_ALL=C sort)
  [ "$found" = "$wanted" ] || die "the release should hold exactly $file, latest.json and SHA256SUMS, and it holds:" "$found"
  if [ -L "$image" ] || [ ! -f "$image" ] || [ -L "$latest" ] || [ ! -f "$latest" ]; then
    die "the release's files are not plain files"
  fi

  [ "$(cat "$folder/SHA256SUMS")" = "$(sums_of "$folder" "$file" latest.json)" ] || die "SHA256SUMS is not right for these files"
  echo "ok: SHA256SUMS is right"

  local info
  info=$(check_image "$image" "$full") || exit 1
  echo "ok: the signature verifies against firmware/keys/fw_signing_pub.pem, and the header says $full"

  local in_repo head
  in_repo=$(version_in_repo) || exit 1
  [ "$in_repo" = "$full" ] || die "firmware/app/VERSION at this tag says $in_repo, and the tag says $full"
  head=$(git --no-optional-locks -C "$REPO_DIR" rev-parse HEAD)
  check_is_a_release_build "$image" "$latest"
  check_latest "$latest" "$image" "$full" "$head"
  check_is_not_golden "$image" "$(text_field "$info" imageHash)"
  echo "ok: this is firmware $full of commit $head, and a release build"
}

main "$@"
