# What scripts/github-release.sh and scripts/verify-github-release.sh both check. Sourced, not run.
# The one that sources it sets REPO_DIR, and defines die, which prints its arguments and exits.

# sha256_of <file>
sha256_of() {
  node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"
}

# json_field <file> <name>: a string as it is, and anything else as JSON. "undefined" if it is not there.
json_field() {
  node -p 'const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; typeof value === "string" ? value : JSON.stringify(value)' "$1" "$2" \
    || die "$1 cannot be read as JSON"
}

# text_field <JSON> <name>
text_field() {
  node -p 'JSON.parse(process.argv[1])[process.argv[2]]' "$1" "$2"
}

# full_version <version>: 1.6.0 gives 1.6.0+0, and 1.6.0+2 stays. So each version has one tag: v1.6.0
# for 1.6.0+0, and never v1.6.0+0.
full_version() {
  case "$1" in
    *+0) die "write $1 as ${1%+0}: a version has one tag" ;;
  esac
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\+[0-9]+)?$ ]] || die "$1 is not a version: it should look like 1.6.0 or 1.6.0+2"
  case "$1" in
    *+*) printf '%s\n' "$1" ;;
    *) printf '%s+0\n' "$1" ;;
  esac
}

# image_file_name <1.6.0+0>: as tools/store_binary.py names it.
image_file_name() {
  printf 'cranium-%s.signed.bin\n' "${1/+/-}"
}

# version_in_repo: firmware/app/VERSION, in the form above.
version_in_repo() {
  local file=$REPO_DIR/firmware/app/VERSION major minor patch tweak extra
  [ -f "$file" ] || die "firmware/app/VERSION is missing"
  major=$(sed -n 's/^VERSION_MAJOR *= *//p' "$file")
  minor=$(sed -n 's/^VERSION_MINOR *= *//p' "$file")
  patch=$(sed -n 's/^PATCHLEVEL *= *//p' "$file")
  tweak=$(sed -n 's/^VERSION_TWEAK *= *//p' "$file")
  extra=$(sed -n 's/^EXTRAVERSION *= *//p' "$file")
  [ -z "$extra" ] || die "firmware/app/VERSION has an EXTRAVERSION, which an MCUboot image cannot carry: $extra"
  printf '%s.%s.%s+%s\n' "$major" "$minor" "$patch" "$tweak"
}

# check_image <image> <version>: the console's own check against the project's key, and the version
# in the image's header. Prints what the check returned.
check_image() {
  local info found
  info=$(node "$REPO_DIR/cloud/api/verify-image.mjs" --key "$REPO_DIR/firmware/keys/fw_signing_pub.pem" "$1") \
    || die "the signature does not verify against firmware/keys/fw_signing_pub.pem"
  found=$(text_field "$info" version)
  [ "$found" = "$2" ] || die "the image's header says $found, and this release is $2"
  printf '%s\n' "$info"
}

# check_is_a_release_build <image> <latest.json>: what can tell a test image or a Bluetooth image from
# a release. store_binary.py keeps neither in binaries/, so this looks for one that got there by hand.
#
# The log lines that a fault writes are in the image's bytes, and so is the Bluetooth stack's. Only
# CONFIG_APP_TEST_FAULT_NO_CONFIRM writes none. That one shows only as a setting in latest.json, like
# anything else from the command line, so an image built with any -D setting is refused.
check_is_a_release_build() {
  local settings
  settings=$(json_field "$2" command_line)
  case "$settings" in
    '[]') ;;
    undefined) die "latest.json does not say how this image was configured: build it again" ;;
    *) die "this image was built with settings from the command line: $settings" \
         "A fault or the Bluetooth option is set that way, and any setting means the commit does not say" \
         "what the image is. Build it again with --pristine." ;;
  esac
  if LC_ALL=C grep -a -q -i -F 'test image:' "$1"; then
    die "this image has a test fault built in: it has a fault's log lines in it"
  fi
  if LC_ALL=C grep -a -q -e 'Bluetooth could not start' -e 'bt_hci_core' "$1"; then
    die "this image has firmware update over Bluetooth built in: it needs a network core that an update cannot give a board"
  fi
}

# check_is_not_golden <image> <imageHash>: the golden image is the way back for every board. It is
# kept out of the repository on purpose, and it never goes out from here.
check_is_not_golden() {
  local manifest=$REPO_DIR/firmware/golden.json digest kept
  digest=$(sha256_of "$1")
  if [ -f "$manifest" ]; then
    if [ "$(json_field "$manifest" file_sha256)" = "$digest" ] || [ "$(json_field "$manifest" hash_tlv)" = "$2" ]; then
      die "this is the golden image, which firmware/golden.json pins: it is never uploaded"
    fi
  fi
  if [ -d "$REPO_DIR/binaries/golden" ]; then
    while IFS= read -r -d '' kept; do
      [ "$(sha256_of "$kept")" != "$digest" ] || die "this image is the same file as binaries/golden/${kept##*/}, which is never uploaded"
    done < <(find "$REPO_DIR/binaries/golden" -type f -print0)
  fi
}

# check_latest <latest.json> <image> <version> <commit>: that it describes this image, of this commit.
check_latest() {
  local latest=$1 image=$2 version=$3 head=$4 commit
  [ "$(json_field "$latest" version)" = "$version" ] || die "latest.json describes version $(json_field "$latest" version), and this release is $version"
  [ "$(json_field "$latest" file)" = "${image##*/}" ] || die "latest.json describes the file $(json_field "$latest" file), and the image is ${image##*/}"
  [ "$(json_field "$latest" sha256)" = "$(sha256_of "$image")" ] || die "latest.json's SHA-256 is not that of ${image##*/}"
  [ "$(json_field "$latest" size)" = "$(wc -c < "$image" | tr -d ' ')" ] || die "latest.json's size is not that of ${image##*/}"
  commit=$(json_field "$latest" commit)
  case "$commit" in
    *+uncommitted) die "this image was built with uncommitted changes ($commit): commit them and build it again" ;;
  esac
  [[ "$commit" =~ ^[0-9a-f]{7,40}$ ]] || die "latest.json does not say which commit this image came from: $commit"
  case "$head" in
    "$commit"*) ;;
    *) die "this image was built from $commit, and this is $head: build it again" ;;
  esac
}

# sums_of <folder> <file>...: the contents of SHA256SUMS, in the form sha256sum writes and checks.
sums_of() {
  local folder=$1 file
  shift
  for file in "$@"; do
    printf '%s  %s\n' "$(sha256_of "$folder/$file")" "$file"
  done
}
