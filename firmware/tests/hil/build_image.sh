#!/bin/zsh
# Build a signed test image from a scratch copy of the firmware sources, so that the
# VERSION file in the working tree never changes.
#
#   firmware/tests/hil/build_image.sh <major.minor.patch> <tweak> <output.bin> [west cmake args]
#
#   firmware/tests/hil/build_image.sh 1.1.2 0 build-bench/images/1.1.2+0.bin
#   firmware/tests/hil/build_image.sh 1.1.9 0 build-bench/images/hang.bin -Dapp_CONFIG_APP_TEST_FAULT_HANG=y
#
# Each kind of image keeps its own build directory under build-bench/, named after the KIND
# environment variable or else its fault, so that a rebuild is incremental. Run from an
# nRF Connect SDK environment with ZEPHYR_BASE set. The image is signed with the key in
# ~/.cranium.
set -e
repo=${0:A:h:h:h:h}
version=$1; tweak=$2; out=${3:A}; shift 3
kind=${KIND:-normal}
if [[ -z ${KIND:-} ]]; then
  for arg in "$@"; do
    case "$arg" in *TEST_FAULT*) kind=${arg#*TEST_FAULT_}; kind=${kind%%=*};; esac
  done
fi
src=$repo/build-bench/src-$kind
build=$repo/build-bench/build-$kind
mkdir -p "$src" "${out:h}"
rsync -a --delete "$repo/firmware/app" "$repo/firmware/netcore" "$repo/firmware/keys" "$src/"
# Sysbuild runs tools/store_binary.py two levels above the application. Here that is
# build-bench/, which has no .git, so the tool knows that this is not the checkout and
# keeps nothing in binaries/.
mkdir -p "$repo/build-bench/tools"
cp "$repo/tools/store_binary.py" "$repo/build-bench/tools/"
printf 'VERSION_MAJOR = %s\nVERSION_MINOR = %s\nPATCHLEVEL = %s\nVERSION_TWEAK = %s\nEXTRAVERSION =\n' \
  ${(s:.:)version} "$tweak" > "$src/app/VERSION"
cd "$ZEPHYR_BASE/.."
west build -d "$build" -b nrf7002dk/nrf5340/cpuapp/ns --sysbuild "$src/app" -- "$@" > "$build.log" 2>&1 \
  || { tail -30 "$build.log"; exit 1; }
cp "$build/app/zephyr/zephyr.signed.bin" "$out"
ls -la "$out" | awk '{print $5, $NF}'
