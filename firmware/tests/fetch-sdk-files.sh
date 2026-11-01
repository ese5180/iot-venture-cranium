#!/usr/bin/env bash
#
# Fetch the few files of nRF Connect SDK v3.4.0 that the host tests and the Python tests read,
# laid out as they are in a full SDK, so that those tests need neither the SDK nor its toolchain:
#
#   firmware/tests/fetch-sdk-files.sh <empty folder>
#   ZEPHYR_BASE=<that folder>/zephyr make -C firmware/tests/host
#
# It takes cJSON and the base64 library that the firmware builds against, MCUboot's imgtool, and
# the headers and sources that test_golden.py holds the bench against. This is no substitute for
# the SDK: nothing can be built for a board with it.
#
# Each revision is the one that the manifest of sdk-nrf v3.4.0 names, as a commit id, so a tag that
# moves cannot change what the tests see. When the project moves to another SDK these move with it,
# and so does NCS_COMMIT in .github/workflows/ci.yml.

set -euo pipefail

# fetch <repository> <commit> <folder in the SDK> <path>...
fetch() {
  local repository=$1 commit=$2 folder=$3
  shift 3
  mkdir -p "$DEST/$folder"
  git -C "$DEST/$folder" init -q
  git -C "$DEST/$folder" remote add origin "https://github.com/$repository"
  # Anchored: a bare VERSION would take every file of that name in the repository.
  git -C "$DEST/$folder" sparse-checkout set --no-cone "${@/#//}"
  git -C "$DEST/$folder" fetch -q --depth=1 --filter=blob:none origin "$commit"
  git -C "$DEST/$folder" -c advice.detachedHead=false checkout -q FETCH_HEAD
  # A path that the commit does not have is no error to sparse-checkout, but it is to the tests.
  local path
  for path in "$@"; do
    [ -e "$DEST/$folder/$path" ] || { echo "error: $repository at $commit has no $path" >&2; exit 1; }
  done
}

if [ $# -ne 1 ]; then
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
mkdir -p "$1"
DEST=$(cd "$1" && pwd)
if [ -n "$(ls -A "$DEST")" ]; then
  echo "error: $DEST is not empty" >&2
  exit 1
fi

fetch nrfconnect/sdk-nrf 99553055607b2e9885fbc80ccd11fa9da81c2df0 nrf \
  VERSION

fetch nrfconnect/sdk-zephyr bf801e4e3d19e1ffa76164346480cb7734dd2800 zephyr \
  lib/utils/base64.c \
  boards/nordic/nrf7002dk/nrf5340_cpuapp_common.dtsi

fetch nrfconnect/sdk-cjson c6af068b7f05207b28d68880740e4b9ec1e4b50a modules/lib/cjson \
  cJSON.c \
  cJSON.h

fetch zephyrproject-rtos/hal_nordic 18da0cc9726f8759c627dba3180b3ba9294e433c modules/hal/nordic \
  nrfx/bsp/stable/mdk/nrf5340_application.h

fetch nrfconnect/sdk-mcuboot c1d2d128a001a97db3ccfd66be524c0232094df6 bootloader/mcuboot \
  scripts/imgtool.py \
  scripts/imgtool \
  boot/bootutil/include/bootutil/boot_hooks.h \
  boot/bootutil/include/bootutil/bootutil_public.h \
  boot/bootutil/src/loader.c \
  boot/boot_serial/src/boot_serial.c \
  boot/zephyr/flash_map_extended.c \
  boot/zephyr/include/sysflash/sysflash.h \
  boot/zephyr/main.c

echo "SDK files are in $DEST"
