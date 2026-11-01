#!/usr/bin/env python3
"""Freeze the golden firmware image, check that everything agrees on it, and put it back.

    python tools/golden.py freeze binaries/cranium-1.4.1-0.signed.bin
    python tools/golden.py qualify "<which bench run qualified it>"
    python tools/golden.py check                   or check --config build/mcuboot/zephyr/.config
    python tools/golden.py restore --reset         or --console, as for tools/recover.py
    python tools/golden.py offsets

The golden image is the one image a board can always go back to. The bootloader holds its
digest, so replacing it takes a debug-port flash of the bootloader as well. firmware/README.md
has the whole story, including the gesture.

freeze takes an image that this checkout built from the commit it is on, with nothing set on the
command line, and which the signing key's public half verifies. It copies the file to
binaries/golden/ (git ignores it, because the repository is public), writes firmware/golden.json
and sets the pin in the bootloader's prj.conf. Commit those two files, and keep a copy of the image
with whoever holds the key.

qualify records which test run qualified the image. It can come after the freeze: the
over-the-air regression needs the final bootloader, and that bootloader holds the pin.

restore needs a board and an nRF Connect SDK terminal, for pyserial and cbor2. freeze needs that
terminal as well, for imgtool. The other commands need neither.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

MCUBOOT_MAGIC = 0x96f3b83d
TLV_INFO_MAGIC = 0x6907
TLV_PROTECTED_INFO_MAGIC = 0x6908
TLV_KEY_HASH = 0x01
TLV_SHA256 = 0x10
TLV_ECDSA_SIGNATURE = 0x22
HEADER_SIZE = 32
# A golden image must fit golden_partition, in MCUboot's overlay.
PARTITION_SIZE = 0xe4000

QUALIFYING_RUN = "qualifying_bench_run"
MANIFEST_FIELDS = ("version", "file", "file_sha256", "hash_tlv", "key_hash_tlv", "size", "commit",
                   "sdk", QUALIFYING_RUN)
UNCOMMITTED = "+uncommitted"

# In the signature TLV: an ASN.1 sequence of two integers, the second one last. A bit this
# far from the end is in that integer, so the signature still parses and only fails to verify.
SIGNATURE_DEPTH = 8


class GoldenError(RuntimeError):
    """Something does not agree, and nothing has been changed."""


@dataclass(frozen=True)
class Image:
    version: str
    file_name_version: str
    header_size: int
    body_size: int
    size: int
    hash_tlv: str
    key_hash_tlv: str
    computed_hash: str
    signature_offset: int
    signature_length: int
    file_sha256: str


def parse_image(data: bytes) -> Image:
    """What an MCUboot image says about itself. Nothing is verified but its own hash."""
    if len(data) < HEADER_SIZE:
        raise GoldenError("this is not an MCUboot image: too short")
    magic, _, header_size, protected_size, body_size = struct.unpack_from("<IIHHI", data)
    if magic != MCUBOOT_MAGIC:
        raise GoldenError("this is not an MCUboot image: wrong magic")
    major, minor, revision, build = struct.unpack_from("<BBHI", data, 20)

    protected_at = header_size + body_size
    tlv_at = protected_at + protected_size
    if protected_size:
        if len(data) < protected_at + 4 or struct.unpack_from("<H", data, protected_at)[0] != TLV_PROTECTED_INFO_MAGIC:
            raise GoldenError("the image's protected metadata is damaged")
    if len(data) < tlv_at + 4:
        raise GoldenError("the image is cut short: its metadata is missing")
    tlv_magic, tlv_total = struct.unpack_from("<HH", data, tlv_at)
    if tlv_magic != TLV_INFO_MAGIC:
        raise GoldenError("the image's metadata is damaged")
    end = tlv_at + tlv_total
    if len(data) < end:
        raise GoldenError("the image is cut short: its metadata does not end")

    found = {}
    offset = tlv_at + 4
    while offset < end:
        if offset + 4 > end:
            raise GoldenError("the image's metadata is damaged")
        tlv_type, tlv_length = struct.unpack_from("<BxH", data, offset)
        offset += 4
        if offset + tlv_length > end:
            raise GoldenError("the image's metadata is damaged")
        found[tlv_type] = (offset, tlv_length)
        offset += tlv_length

    for tlv_type, name in ((TLV_SHA256, "hash"), (TLV_KEY_HASH, "key hash"),
                           (TLV_ECDSA_SIGNATURE, "signature")):
        if tlv_type not in found:
            raise GoldenError(f"the image has no {name}")

    def value(tlv_type: int) -> bytes:
        at, length = found[tlv_type]
        return data[at:at + length]

    signature_offset, signature_length = found[TLV_ECDSA_SIGNATURE]
    return Image(version=f"{major}.{minor}.{revision}+{build}",
                 file_name_version=f"{major}.{minor}.{revision}-{build}",
                 header_size=header_size, body_size=body_size, size=end,
                 hash_tlv=value(TLV_SHA256).hex(), key_hash_tlv=value(TLV_KEY_HASH).hex(),
                 computed_hash=hashlib.sha256(data[:tlv_at]).hexdigest(),
                 signature_offset=signature_offset, signature_length=signature_length,
                 file_sha256=hashlib.sha256(data).hexdigest())


def check_image_alone(image: Image, length: int) -> None:
    """What can be said about an image without its key."""
    if image.computed_hash != image.hash_tlv:
        raise GoldenError("the image does not match its own hash: it has been damaged")
    if image.size != length:
        raise GoldenError(f"the file is {length} bytes and the image says {image.size}")
    if image.size > PARTITION_SIZE:
        raise GoldenError(f"the image does not fit golden_partition: {image.size} bytes")


def flip_offsets(data: bytes) -> dict[str, int]:
    """A byte in the body and a byte in the signature that each have a bit left to clear."""
    image = parse_image(data)

    def next_set(start: int, stop: int, step: int) -> int:
        for offset in range(start, stop, step):
            if data[offset]:
                return offset
        raise GoldenError("no byte with a bit set in that part of the image")

    body_end = image.header_size + image.body_size
    signature_end = image.signature_offset + image.signature_length
    return {
        "body": next_set(image.header_size + image.body_size // 2, body_end, 1),
        "signature": next_set(signature_end - SIGNATURE_DEPTH, image.signature_offset, -1),
    }


# ---- what the bootloader's prj.conf says --------------------------------------------------

PIN_LINE = re.compile(r"^CONFIG_CRANIUM_GOLDEN(?:_SHA256|_SIZE)?=.*\n?", re.MULTILINE)
PIN_NAME = re.compile(r"^(CONFIG_CRANIUM_GOLDEN(?:_SHA256|_SIZE)?)=", re.MULTILINE)
PIN_ON = "CONFIG_CRANIUM_GOLDEN=y"
PIN_HASH = re.compile(r'^CONFIG_CRANIUM_GOLDEN_SHA256="([0-9a-f]*)"$', re.MULTILINE)
PIN_SIZE = re.compile(r"^CONFIG_CRANIUM_GOLDEN_SIZE=(\d+)$", re.MULTILINE)


def set_pin(text: str, hash_tlv: str, size: int) -> str:
    """The three lines take the place of the first of them that is there. The bootloader's
    configuration comes with one, so that there is always a place for them."""
    lines = f'{PIN_ON}\nCONFIG_CRANIUM_GOLDEN_SHA256="{hash_tlv}"\nCONFIG_CRANIUM_GOLDEN_SIZE={size}\n'
    match = PIN_LINE.search(text)
    if match is None:
        raise GoldenError("the bootloader's prj.conf has no CONFIG_CRANIUM_GOLDEN line")
    return text[:match.start()] + lines + PIN_LINE.sub("", text[match.start():])


def read_pin(text: str) -> tuple[bool, str | None, int | None]:
    """Whether the setting is on, the digest and the size. For Kconfig the last assignment wins.
    Rather than guess at which one a build used, a file that sets one twice is refused."""
    names = PIN_NAME.findall(text)
    repeated = sorted({name for name in names if names.count(name) > 1})
    if repeated:
        raise GoldenError(f"the bootloader's configuration sets {', '.join(repeated)} more than once")
    on = re.search(rf"^{PIN_ON}$", text, re.MULTILINE) is not None
    digest = PIN_HASH.search(text)
    size = PIN_SIZE.search(text)
    return on, digest.group(1) if digest else None, int(size.group(1)) if size else None


# ---- the repository ------------------------------------------------------------------------


class Checkout:
    def __init__(self, root: Path):
        self.root = root
        self.manifest = root / "firmware" / "golden.json"
        self.prj_conf = root / "firmware" / "app" / "sysbuild" / "mcuboot" / "prj.conf"
        self.public_key = root / "firmware" / "keys" / "fw_signing_pub.pem"
        self.latest = root / "binaries" / "latest.json"
        self.frozen = root / "binaries" / "golden"

    def git(self, *arguments: str) -> str:
        result = subprocess.run(["git", "-C", str(self.root), *arguments], capture_output=True, text=True)
        if result.returncode != 0:
            raise GoldenError(f"git {arguments[0]}: {result.stderr.strip()}")
        return result.stdout

    def dirty(self) -> list[str]:
        """Changes that matter: to a tracked file anywhere, and any new file under firmware/.
        A new file elsewhere, such as a manual left at the top of the tree, changes no image."""
        changed = self.git("status", "--porcelain", "--untracked-files=no").splitlines()
        new = self.git("status", "--porcelain", "--untracked-files=all", "firmware").splitlines()
        return sorted(set(changed) | {line for line in new if line.startswith("??")})

    def read_manifest(self) -> dict:
        if not self.manifest.exists():
            raise GoldenError("nothing has been frozen: there is no firmware/golden.json")
        manifest = json.loads(self.manifest.read_text())
        missing = [field for field in MANIFEST_FIELDS if field not in manifest]
        if missing:
            raise GoldenError(f"firmware/golden.json has no {', '.join(missing)}")
        return manifest

    def write_manifest(self, manifest: dict) -> None:
        self.manifest.write_text(json.dumps(manifest, indent=2) + "\n")

    def frozen_image(self, manifest: dict) -> Path:
        return self.frozen / manifest["file"]


def sdk_version() -> str:
    base = os.environ.get("ZEPHYR_BASE")
    if not base:
        raise GoldenError("ZEPHYR_BASE is not set: run this from an nRF Connect SDK terminal")
    text = (Path(base).parent / "nrf" / "VERSION").read_text()
    fields = dict(re.findall(r"^(\w+) = (\w*)$", text, re.MULTILINE))
    return f"{fields['VERSION_MAJOR']}.{fields['VERSION_MINOR']}.{fields['PATCHLEVEL']}"


def verify_signature(path: Path, public_key: Path, expected_hash: str) -> None:
    """The signature as MCUboot's own tool checks it, with the key in the repository."""
    base = os.environ.get("ZEPHYR_BASE")
    if not base:
        raise GoldenError("ZEPHYR_BASE is not set: run this from an nRF Connect SDK terminal")
    tool = Path(base).parent / "bootloader" / "mcuboot" / "scripts" / "imgtool.py"
    result = subprocess.run([sys.executable, str(tool), "verify", "-k", str(public_key), str(path)],
                            capture_output=True, text=True)
    if result.returncode != 0:
        raise GoldenError(f"imgtool refuses the image: {(result.stdout + result.stderr).strip()}")
    if f"Image digest: {expected_hash}" not in result.stdout:
        raise GoldenError(f"imgtool reports another digest: {result.stdout.strip()}")


# ---- the commands --------------------------------------------------------------------------


def freeze(checkout: Checkout, path: Path, replace: bool = False, qualifying_run: str | None = None,
           older_commit: bool = False) -> dict:
    """Make this image the golden one. Nothing is written until every check has passed."""
    data = path.read_bytes()
    image = parse_image(data)
    check_image_alone(image, len(data))

    if not checkout.latest.exists():
        raise GoldenError("binaries/latest.json is missing: build this version from this checkout")
    latest = json.loads(checkout.latest.read_text())
    if latest.get("sha256") != image.file_sha256:
        raise GoldenError(f"binaries/latest.json describes another build ({latest.get('file')}): "
                          "only the newest build of this checkout can be frozen")
    commit = latest.get("commit", "unknown")
    if commit.endswith(UNCOMMITTED):
        raise GoldenError(f"this image was built with uncommitted changes ({commit}): "
                          "commit them and build it again")
    if commit == "unknown":
        raise GoldenError("binaries/latest.json does not say which commit this image came from")
    settings = latest.get("command_line")
    if settings is None:
        raise GoldenError("binaries/latest.json does not say how this image was configured: build it again")
    if settings:
        raise GoldenError("this image was built with settings from the command line, which stay in the "
                          f"build directory: {', '.join(settings)}. Build it again with --pristine")

    dirty = checkout.dirty()
    if dirty:
        raise GoldenError("the tree has uncommitted changes, so the commit that built this image "
                          "says nothing about it:\n  " + "\n  ".join(dirty[:10]))
    try:
        checkout.git("merge-base", "--is-ancestor", commit, "HEAD")
    except GoldenError as error:
        raise GoldenError(f"commit {commit} that built this image is not in this history") from error
    if not older_commit and checkout.git("rev-parse", commit) != checkout.git("rev-parse", "HEAD"):
        raise GoldenError(f"this image was built from {commit}, and this checkout has moved on. Build it "
                          "again, or pass --older-commit if nothing since then touches the image")

    if checkout.manifest.exists():
        pinned = checkout.read_manifest()
        if pinned["hash_tlv"] == image.hash_tlv:
            raise GoldenError(f"{pinned['version']} is frozen already")
        if not replace:
            raise GoldenError(f"{pinned['version']} is frozen already. Replacing it means a debug-port "
                              "flash of every board's bootloader: pass --replace if that is the plan")

    verify_signature(path, checkout.public_key, image.hash_tlv)
    manifest = {
        "version": image.version,
        "file": f"cranium-{image.file_name_version}.signed.bin",
        "file_sha256": image.file_sha256,
        "hash_tlv": image.hash_tlv,
        "key_hash_tlv": image.key_hash_tlv,
        "size": image.size,
        "commit": commit,
        "sdk": sdk_version(),
        QUALIFYING_RUN: qualifying_run,
    }
    prj_conf = set_pin(checkout.prj_conf.read_text(), image.hash_tlv, image.size)

    checkout.frozen.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, checkout.frozen_image(manifest))
    checkout.write_manifest(manifest)
    checkout.prj_conf.write_text(prj_conf)
    return manifest


def qualify(checkout: Checkout, bench_run: str) -> dict:
    manifest = checkout.read_manifest()
    if not bench_run.strip():
        raise GoldenError("say which bench run qualified the image")
    manifest[QUALIFYING_RUN] = bench_run.strip()
    checkout.write_manifest(manifest)
    return manifest


def check(checkout: Checkout, image_path: Path | None = None,
          built_config: Path | None = None) -> tuple[dict, bytes]:
    """The manifest, the bootloader's configuration and the file all name the same image.
    built_config is a built bootloader's .config, for what a build really used: prj.conf says what
    a build should use, and neither says what is on a board. Returns the manifest and the file's
    content."""
    manifest = checkout.read_manifest()

    on, digest, size = read_pin(checkout.prj_conf.read_text())
    if not on:
        raise GoldenError("the bootloader's prj.conf does not have the golden image turned on")
    if digest != manifest["hash_tlv"]:
        raise GoldenError(f"the bootloader's prj.conf pins {digest}, and firmware/golden.json "
                          f"says {manifest['hash_tlv']}")
    if size != manifest["size"]:
        raise GoldenError(f"the bootloader's prj.conf says {size} bytes, and firmware/golden.json "
                          f"says {manifest['size']}")
    if built_config is not None:
        built = read_pin(built_config.read_text())
        if built != (True, manifest["hash_tlv"], manifest["size"]):
            raise GoldenError(f"{built_config} was built with {built}, and firmware/golden.json says "
                              f"{manifest['hash_tlv']}, {manifest['size']} bytes")

    path = image_path or checkout.frozen_image(manifest)
    if not path.exists():
        raise GoldenError(f"{path} is missing: git does not keep it, so take the copy held with "
                          "the signing key")
    data = path.read_bytes()
    image = parse_image(data)
    check_image_alone(image, len(data))
    if image.file_sha256 != manifest["file_sha256"]:
        raise GoldenError(f"{path.name} is not the file that was frozen: its SHA-256 is "
                          f"{image.file_sha256}, and firmware/golden.json says {manifest['file_sha256']}")
    for field, have in (("hash_tlv", image.hash_tlv), ("key_hash_tlv", image.key_hash_tlv),
                        ("size", image.size), ("version", image.version)):
        if have != manifest[field]:
            raise GoldenError(f"{path.name} says {field} {have}, and firmware/golden.json says "
                              f"{manifest[field]}")
    return manifest, data


def restore(checkout: Checkout, image_path: Path | None, port: str | None, serial_number: str | None,
            through_console: bool) -> None:
    """check, and only then send anything: a file that fails it never reaches the board."""
    manifest, data = check(checkout, image_path)

    # Only here, since everything else in this tool works without pyserial and cbor2.
    import recover
    from board import find_console_port

    link = recover.Link(port or find_console_port())
    try:
        recover.enter(link, serial_number, through_console, recover.ENTER_THROUGH_A_SWAP)
        recover.upload(link, data)
        link.request(recover.OP_WRITE, recover.GROUP_OS, recover.ID_OS_RESET, {})
    finally:
        link.close()
    print(f"Restarting. Sent {manifest['version']}, and the bootloader checks its signature before it "
          "starts it. It is not sealed by this: do the gesture if the golden copy needs it. The secondary "
          "slot is left as it was, and only a restore by the gesture empties it.")


def main(argv: list[str] | None = None, checkout: Checkout | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    command = commands.add_parser("freeze", help="make this image the golden one")
    command.add_argument("image", type=Path, help="binaries/cranium-<version>.signed.bin")
    command.add_argument("--replace", action="store_true", help="replace another frozen image")
    command.add_argument("--qualifying-run", help="if the image has been qualified already")
    command.add_argument("--older-commit", action="store_true",
                         help="the image comes from an earlier commit of this history, on purpose")

    command = commands.add_parser("qualify", help="record which bench run qualified the image")
    command.add_argument("bench_run")

    command = commands.add_parser("check", help="firmware/golden.json, prj.conf and the file agree")
    command.add_argument("--image", type=Path, help="check this file instead of the frozen one")
    command.add_argument("--qualified", action="store_true", help="fail if no bench run is recorded")
    command.add_argument("--config", type=Path,
                         help="also check a built bootloader's .config: build/mcuboot/zephyr/.config")

    command = commands.add_parser("restore", help="check, then send the image through serial recovery")
    command.add_argument("--image", type=Path, help="send this file instead of the frozen one")
    command.add_argument("--port", help="serial port (default: the board's second virtual COM port)")
    command.add_argument("--reset", action="store_true", help="restart the board through its debug port")
    command.add_argument("--console", action="store_true", help="send ENTER_BOOTLOADER to the application")
    command.add_argument("--serial-number", default="001050797470", help="the debug probe to use with --reset")

    command = commands.add_parser("offsets", help="where to flip a bit, for the tamper tests")
    command.add_argument("--image", type=Path, help="this file instead of the frozen one")

    args = parser.parse_args(argv)
    checkout = checkout or Checkout(Path(__file__).resolve().parents[1])

    try:
        if args.command == "freeze":
            manifest = freeze(checkout, args.image, args.replace, args.qualifying_run, args.older_commit)
            print(f"Frozen: {manifest['version']}, digest {manifest['hash_tlv']}.\n"
                  "Commit firmware/golden.json and the bootloader's prj.conf, keep a copy of "
                  f"binaries/golden/{manifest['file']} with whoever holds the signing key, and "
                  "record the bench run that qualifies it with `golden.py qualify`.")
        elif args.command == "qualify":
            manifest = qualify(checkout, args.bench_run)
            print(f"Recorded for {manifest['version']}. Commit firmware/golden.json.")
        elif args.command == "check":
            manifest, _ = check(checkout, args.image, args.config)
            print(f"All in agreement: {manifest['version']}, digest {manifest['hash_tlv']}.")
            if manifest[QUALIFYING_RUN]:
                print(f"Qualified by: {manifest[QUALIFYING_RUN]}")
            elif args.qualified:
                raise GoldenError("no bench run is recorded for it yet")
            else:
                print("No bench run is recorded for it yet.")
        elif args.command == "restore":
            if args.reset and args.console:
                parser.error("--reset and --console are two ways of doing the same thing: pick one")
            restore(checkout, args.image, args.port, args.serial_number if args.reset else None,
                    args.console)
        else:
            if args.image is not None:
                data = args.image.read_bytes()
            else:
                _, data = check(checkout)
            for name, offset in flip_offsets(data).items():
                print(f"{name} {offset}")
    except (RuntimeError, OSError, ValueError) as error:
        # RuntimeError takes in GoldenError, and BoardError from the tools that talk to a board.
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
