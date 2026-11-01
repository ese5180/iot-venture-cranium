#!/usr/bin/env bash
#
# Update the board over the air with what is in binaries/.
#
#   scripts/ota.sh                     install binaries/latest.signed.bin
#   scripts/ota.sh <image>             install that signed image
#   scripts/ota.sh --cloud-only        use no serial port, also if one is there
#   scripts/ota.sh --thing <name>      which board, if the account has more than one
#
# It uploads the image through the console's API, which checks the signature before it
# stores anything, deploys it to the board, and follows the update until the new firmware
# has confirmed itself. The same thing can be done by hand on the console's Firmware page.
# The version must be newer than every release uploaded so far: set it in
# firmware/app/VERSION and build. A build puts its image in binaries/ by itself.
#
# The board does not have to be on USB. With no console found, or with --cloud-only, the update is
# followed through the job and the device shadow with AWS credentials. Firmware from 1.7.2 on starts
# the update by itself. Older firmware, such as the frozen golden image 1.5.0, reports that it waits
# for Button 1: the button is then pressed through the board's development console if it has one, and
# otherwise the script says so and waits for a person. The AWS profile comes from AWS_PROFILE (default
# cranium). The release manager to act as comes from CRANIUM_RELEASE_MANAGER; if it is not set, the
# one active release manager is used, and if there are several the script asks you to choose.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NRFUTIL="${NRFUTIL:-$HOME/.nrfutil/bin/nrfutil}"
NCS_VERSION=v3.4.0

export AWS_PROFILE="${AWS_PROFILE:-cranium}"
export AWS_REGION="${AWS_REGION:-us-east-1}"

die() {
  printf 'error: %s\n' "$1" >&2
  shift
  if [ $# -gt 0 ]; then
    printf '       %s\n' "$@" >&2
  fi
  exit 1
}

usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

image="$REPO_DIR/binaries/latest.signed.bin"
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --cloud-only)
      extra+=("--cloud-only")
      ;;
    --thing)
      [ $# -ge 2 ] || die "--thing needs the board's thing name"
      extra+=("--thing" "$2")
      shift
      ;;
    -*)
      die "unknown option: $1" "See scripts/ota.sh --help."
      ;;
    *)
      image="$1"
      ;;
  esac
  shift
done

[ -f "$image" ] || die "there is no image at $image" \
  "Build the firmware first: a build stores its signed image in binaries/."

who="${CRANIUM_RELEASE_MANAGER:-}"
if [ -z "$who" ]; then
  who="$("$REPO_DIR/cloud/users.sh" list | awk '$2 == "release-manager" && $3 == "active" { print $1 }')"
fi
case "$who" in
  "") die "no active release manager: finish a first sign-in to the console" ;;
  *[[:space:]]*) die "there are several active release managers" \
    "Say which one with CRANIUM_RELEASE_MANAGER=<email> scripts/ota.sh" ;;
esac

[ -x "$NRFUTIL" ] || die "nrfutil was not found at $NRFUTIL" "Set NRFUTIL to where it is."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
"$NRFUTIL" sdk-manager toolchain env --ncs-version "$NCS_VERSION" --as-script sh > "$work/env.sh"
# shellcheck disable=SC1091
. "$work/env.sh"
export ZEPHYR_BASE="${ZEPHYR_BASE:-/opt/nordic/ncs/$NCS_VERSION/zephyr}"

echo "Installing $image, acting as $who"
exec python3 "$REPO_DIR/firmware/tests/hil/ota_bench.py" update "$image" \
  --via api --as "$who" ${extra[@]+"${extra[@]}"}
