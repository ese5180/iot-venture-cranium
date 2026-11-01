#!/usr/bin/env bash
#
# Publish the image in binaries/ as a GitHub Release. Run by the person who holds the signing key,
# after a build of this commit. GitHub Actions never has the key, so only this can make an image a
# board will install.
#
#   scripts/github-release.sh 1.6.0             check everything, tag v1.6.0, and publish
#   scripts/github-release.sh 1.6.0+2           the same, for a version with a build number
#   scripts/github-release.sh 1.6.0 --dry-run   check everything and write nothing
#
# It refuses unless no tracked file has changed, HEAD is on a branch of origin, the version is the one
# in firmware/app/VERSION and in the image's header, the signature verifies against
# firmware/keys/fw_signing_pub.pem with the console's own check, and binaries/latest.json names this
# commit. It refuses a test image, a Bluetooth image, the golden image, and a version that already has
# a tag or a release. It uploads the signed image, latest.json and SHA256SUMS, and nothing else.
#
# It needs git, node and a signed-in gh. GitHub Actions then checks what was published: see docs/ci.md.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() {
  printf 'refused: %s\n' "$1" >&2
  shift
  if [ $# -gt 0 ]; then
    printf '         %s\n' "$@" >&2
  fi
  exit 1
}

usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# shellcheck source=scripts/release-lib.sh
. "$REPO_DIR/scripts/release-lib.sh"

# --no-optional-locks: a check writes nothing, not even a refreshed index.
git_here() {
  git --no-optional-locks -C "$REPO_DIR" "$@"
}

check_tree_is_clean() {
  local changed
  changed=$(git_here status --porcelain --untracked-files=no)
  [ -z "$changed" ] || die "tracked files have changed, so the commit says nothing about this image:" "$changed"
}

# Against what origin holds now. The branches this checkout remembers can be out of date.
check_head_is_pushed() {
  local head=$1 remote_heads tip
  remote_heads=$(git_here ls-remote --heads origin) || die "origin cannot be reached"
  while read -r tip _; do
    [ -n "$tip" ] || continue
    if git_here cat-file -e "$tip^{commit}" 2>/dev/null && git_here merge-base --is-ancestor "$head" "$tip"; then
      return 0
    fi
  done <<< "$remote_heads"
  die "HEAD ($head) is on no branch of origin: push it first"
}

check_tag_is_free() {
  local tag=$1 head=$2 local_tag
  [ -z "$(git_here ls-remote --tags origin "refs/tags/$tag")" ] || die "origin already has the tag $tag"
  local_tag=$(git_here rev-parse -q --verify "refs/tags/$tag^{commit}" || true)
  [ -z "$local_tag" ] || [ "$local_tag" = "$head" ] || die "this checkout has a tag $tag on another commit, $local_tag"
  if (cd "$REPO_DIR" && gh release view "$tag" > /dev/null 2>&1); then
    die "GitHub already has a release for $tag"
  fi
}

main() {
  local dry_run=0 version='' argument
  for argument in "$@"; do
    case "$argument" in
      --dry-run) dry_run=1 ;;
      -h|--help) usage; exit 0 ;;
      -*) usage >&2; exit 2 ;;
      *)
        if [ -n "$version" ]; then usage >&2; exit 2; fi
        version=$argument
        ;;
    esac
  done
  if [ -z "$version" ]; then usage >&2; exit 2; fi

  local tool
  for tool in git node gh; do
    command -v "$tool" > /dev/null || die "$tool is not installed"
  done
  (cd "$REPO_DIR" && gh auth status > /dev/null 2>&1) || die "gh is not signed in: run gh auth login"

  local full tag head in_repo
  full=$(full_version "$version") || exit 1
  tag=v$version
  head=$(git_here rev-parse HEAD)

  in_repo=$(version_in_repo) || exit 1
  [ "$in_repo" = "$full" ] || die "firmware/app/VERSION says $in_repo, and this release is $full"
  check_tree_is_clean
  check_head_is_pushed "$head"
  check_tag_is_free "$tag" "$head"

  local binaries=$REPO_DIR/binaries file image latest
  latest=$binaries/latest.json
  file=$(image_file_name "$full")
  image=$binaries/$file
  if [ ! -f "$latest" ] || [ -L "$latest" ]; then
    die "binaries/latest.json is missing or is a link: build this version from this checkout"
  fi
  if [ ! -f "$image" ] || [ -L "$image" ]; then
    die "binaries/$file is missing or is a link: build this version from this checkout"
  fi

  # In this order, so that a test image is named for what it is whatever else is wrong with it.
  check_is_a_release_build "$image" "$latest"
  check_latest "$latest" "$image" "$full" "$head"
  local info
  info=$(check_image "$image" "$full") || exit 1
  check_is_not_golden "$image" "$(text_field "$info" imageHash)"

  echo "ok: $file is firmware $full, of commit $head, signed with the project's key"
  if [ "$dry_run" = 1 ]; then
    echo "dry run: nothing was written. Without --dry-run this makes the tag $tag and uploads:"
    sums_of "$binaries" "$file" latest.json
    return 0
  fi

  local stage url
  stage=$(mktemp -d)
  # shellcheck disable=SC2064 # The folder is known now, and $stage is local to this function.
  trap "rm -rf '$stage'" EXIT
  cp "$image" "$latest" "$stage/"
  sums_of "$stage" "$file" latest.json > "$stage/SHA256SUMS"

  # gh makes the tag on this commit when it publishes, and it publishes after the last upload, so
  # the check on GitHub Actions finds every file and a failed upload leaves no tag behind.
  url=$(cd "$REPO_DIR" && gh release create "$tag" --target "$head" --title "Firmware $full" \
    --notes "Firmware $full, built from commit $head and signed with the project's key. To install it, see binaries/README.md." \
    "$stage/$file" "$stage/latest.json" "$stage/SHA256SUMS")
  echo "$url"
}

main "$@"
