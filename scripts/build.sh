#!/usr/bin/env bash
#
# Build the firmware with the next version, and leave the signed image in binaries/.
#
#   scripts/build.sh                   the next unused version, for example 1.7.10 after 1.7.9
#   scripts/build.sh --version 1.8.0   that version instead
#   scripts/build.sh --keep            the version already in firmware/app/VERSION
#   scripts/build.sh --jobs 8          compile with that many jobs (default 4)
#
# Each build starts clean, and stores binaries/cranium-<version>-0.signed.bin, along with
# binaries/latest.signed.bin and binaries/latest.json. It then checks the image's signature with
# the same code the console uses. Upload that file on the console's Firmware page, or run
# scripts/ota.sh. A version can be uploaded only once, which is why each build takes a new one.
#
# The next version is one above the highest in firmware/app/VERSION, binaries/ and ota-demo/. This
# checkout cannot see what else has been uploaded, so the console may still refuse a number. A
# failed build puts firmware/app/VERSION back. A good one leaves it changed and not committed:
# commit it before you build anything you mean to release, because the image records its commit.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NRFUTIL="${NRFUTIL:-$HOME/.nrfutil/bin/nrfutil}"
NCS_VERSION=v3.4.0
NCS_DIR="/opt/nordic/ncs/$NCS_VERSION"
BOARD=nrf7002dk/nrf5340/cpuapp/ns
VERSION_FILE="$REPO_DIR/firmware/app/VERSION"
KEY="$HOME/.cranium/mcuboot_signing_key.pem"

die() {
  echo "error: $1" >&2
  [ $# -lt 2 ] || echo "$2" >&2
  exit 1
}

usage() {
  sed -n '3,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

field() {
  awk -v name="$1" '$1 == name { print $3 }' "$VERSION_FILE"
}

set_version() {
  local major="$1" minor="$2" patch="$3" file
  file="$(mktemp)"
  awk -v major="$major" -v minor="$minor" -v patch="$patch" '
    $1 == "VERSION_MAJOR" { print "VERSION_MAJOR = " major; next }
    $1 == "VERSION_MINOR" { print "VERSION_MINOR = " minor; next }
    $1 == "PATCHLEVEL" { print "PATCHLEVEL = " patch; next }
    $1 == "VERSION_TWEAK" { print "VERSION_TWEAK = 0"; next }
    { print }' "$VERSION_FILE" > "$file"
  cat "$file" > "$VERSION_FILE"
  rm -f "$file"
}

# The next patch number above everything this checkout knows about, as "major minor patch".
next_version() {
  python3 -I - "$(field VERSION_MAJOR).$(field VERSION_MINOR).$(field PATCHLEVEL)" \
    "$REPO_DIR"/binaries/cranium-*.signed.bin "$REPO_DIR"/ota-demo/cranium-*.signed.bin <<'EOF'
import re, sys
seen = [tuple(int(n) for n in sys.argv[1].split("."))]
for name in sys.argv[2:]:
    found = re.search(r"cranium-(\d+)\.(\d+)\.(\d+)-", name)
    if found:
        seen.append(tuple(int(n) for n in found.groups()))
major, minor, patch = max(seen)
print(major, minor, patch + 1)
EOF
}

jobs=4
keep=false
version=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) keep=true ;;
    --version)
      [ $# -ge 2 ] || die "--version needs a value, for example --version 1.8.0"
      version="$2"
      shift
      ;;
    --jobs)
      [ $# -ge 2 ] || die "--jobs needs a number"
      jobs="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift
done

[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || die "--jobs must be a number, not $jobs"
[ -n "$version" ] && [ "$keep" = true ] && die "use --keep or --version, not both"
if [ -n "$version" ] && ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "--version must look like 1.8.0, not $version"
fi

[ -x "$NRFUTIL" ] || die "nrfutil was not found at $NRFUTIL" "Set NRFUTIL to where it is."
[ -d "$NCS_DIR" ] || die "nRF Connect SDK $NCS_VERSION was not found at $NCS_DIR"
[ -f "$KEY" ] || die "the signing key was not found at $KEY" \
  "See secrets/README.md. An image signed with another key will not install on a board."

work="$(mktemp -d)"
version_before="$work/VERSION.before"
cp "$VERSION_FILE" "$version_before"
built=false
finish() {
  # A build that failed has used no number.
  [ "$built" = true ] || cat "$version_before" > "$VERSION_FILE"
  rm -rf "$work"
}
trap finish EXIT
# Ctrl-C has to go through the same way.
trap 'exit 130' INT TERM

if [ -n "$version" ]; then
  IFS=. read -r major minor patch <<< "$version"
  set_version "$major" "$minor" "$patch"
elif [ "$keep" = false ]; then
  # shellcheck disable=SC2046
  set_version $(next_version)
fi
expected="$(field VERSION_MAJOR).$(field VERSION_MINOR).$(field PATCHLEVEL)+$(field VERSION_TWEAK)"

log="$work/build.log"
"$NRFUTIL" sdk-manager toolchain env --ncs-version "$NCS_VERSION" --as-script sh > "$work/env.sh"
# shellcheck disable=SC1091
. "$work/env.sh"
export ZEPHYR_BASE="$NCS_DIR/zephyr"
export CMAKE_BUILD_PARALLEL_LEVEL="$jobs"

echo "Building firmware $expected with $jobs jobs. This takes a minute or two."
if ! (cd "$NCS_DIR" && nice -n 5 west build -p always -d "$REPO_DIR/build" -b "$BOARD" \
    --sysbuild "$REPO_DIR/firmware/app" -- ) > "$log" 2>&1; then
  mkdir -p "$REPO_DIR/build"
  cp "$log" "$REPO_DIR/build/last-build.log"
  grep -E "error:|FATAL_ERROR|CMake Error" "$log" | head -10 >&2 || true
  die "the build failed" "The whole log is in build/last-build.log."
fi
cp "$log" "$REPO_DIR/build/last-build.log"

name="cranium-${expected%+*}-${expected#*+}.signed.bin"
file="$REPO_DIR/binaries/$name"
[ -f "$file" ] || die "the build left no image at binaries/$name"
cmp -s "$file" "$REPO_DIR/binaries/latest.signed.bin" \
  || die "binaries/latest.signed.bin is not the image that was just built"

python3 -I - "$REPO_DIR/binaries/latest.json" "$expected" <<'EOF' || die "binaries/latest.json does not match this build"
import json, sys
info = json.load(open(sys.argv[1]))
if info.get("version") != sys.argv[2]:
    sys.exit(f"it says {info.get('version')}, and this build is {sys.argv[2]}")
print()
print(f"Version   {info['version']}")
print(f"File      binaries/{info['file']}")
print(f"Size      {info['size']:,} bytes, of a 933,888 byte slot")
print(f"SHA-256   {info['sha256']}")
print(f"Commit    {info['commit']}")
EOF

if command -v node > /dev/null; then
  if ! node "$REPO_DIR/cloud/api/verify-image.mjs" "$file" > "$work/verify.txt" 2>&1; then
    cat "$work/verify.txt" >&2
    die "the image failed the signature check" \
      "A build signed with another key will not install: see secrets/README.md."
  fi
  echo "Signature checked with this project's public key."
else
  echo "node was not found, so the signature was not checked here. The console checks it on upload."
fi
built=true

echo
if git -C "$REPO_DIR" status --porcelain -- firmware tools 2>/dev/null \
    | grep -qv ' firmware/app/VERSION$'; then
  echo "warning: firmware has uncommitted changes, so this image does not match any one commit."
elif ! git -C "$REPO_DIR" diff --quiet -- firmware/app/VERSION 2>/dev/null; then
  echo "firmware/app/VERSION now says ${expected%+*}, and that change is not committed."
fi

echo "Next: upload binaries/$name on the console's Firmware page, or run scripts/ota.sh."
