#!/usr/bin/env python3
"""Keep the signed image of the latest build in binaries/. Run by every `west build`.

    binaries/cranium-1.2.0-0.signed.bin    this version, named so that the console accepts it
    binaries/latest.signed.bin             a copy of the newest build
    binaries/latest.json                   its version, size, digest, git commit and -D settings

Only a build of the checkout itself is kept: the test bench builds from scratch copies,
which have no .git, and an image built with a test fault is refused. So is one built for
firmware update over Bluetooth, which needs a network core that a board only gets over the
debug port, and which scripts/ota.sh should not find by accident. A signed image is not a
secret, but it is large and can be rebuilt, so git ignores these files.

Install what is stored here with scripts/ota.sh, or upload it on the console's Firmware page.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MCUBOOT_MAGIC = 0x96f3b83d
KEEP = 10


def image_version(data: bytes) -> tuple[str, str]:
    """The version in an MCUboot header, as text and as it can be used in a file name."""
    if len(data) < 32 or int.from_bytes(data[0:4], "little") != MCUBOOT_MAGIC:
        sys.exit("store_binary: this is not an MCUboot image")
    major, minor = data[20], data[21]
    revision = int.from_bytes(data[22:24], "little")
    build = int.from_bytes(data[24:28], "little")
    return f"{major}.{minor}.{revision}+{build}", f"{major}.{minor}.{revision}-{build}"


def has_test_fault(config: Path) -> bool:
    text = config.read_text() if config.exists() else ""
    return re.search(r"^CONFIG_APP_TEST_FAULT_(?!NONE)\w+=y$", text, re.MULTILINE) is not None


def has_bluetooth_update(config: Path) -> bool:
    text = config.read_text() if config.exists() else ""
    return re.search(r"^CONFIG_APP_BT_OTA=y$", text, re.MULTILINE) is not None


def command_line_settings(build: Path) -> list[str]:
    """What -D gave this build. CMake keeps it in the build directory's cache, so it goes on
    changing images after the command that set it is forgotten, on a tree that git calls clean.
    An entry of the form -DNAME:TYPE=value is not seen: this is a record, not a lock."""
    cache = build / "CMakeCache.txt"
    text = cache.read_text() if cache.exists() else ""
    found = re.findall(r"^(\w+):UNINITIALIZED=(.*)$", text, re.MULTILINE)
    # West's own, which every build has.
    return [f"{name}={value}" for name, value in found if name != "WEST_PYTHON"]


def git_commit(repo: Path) -> str:
    try:
        commit = subprocess.run(["git", "-C", str(repo), "rev-parse", "--short", "HEAD"],
                                capture_output=True, text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(repo), "status", "--porcelain", "firmware"],
                               capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return f"{commit}+uncommitted" if dirty else commit


def prune(folder: Path) -> None:
    """Keep the newest versions; a folder that nobody tidies does not grow for ever."""
    images = sorted(folder.glob("cranium-*.signed.bin"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in images[KEEP:]:
        old.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--build", required=True, type=Path, help="the sysbuild build directory")
    parser.add_argument("--repo", required=True, type=Path, help="the root of the source tree")
    args = parser.parse_args()

    if not (args.repo / ".git").exists():
        print(f"store_binary: {args.repo} is not the checkout, so nothing is kept")
        return
    if has_test_fault(args.build / "app" / "zephyr" / ".config"):
        print("store_binary: this image has a test fault built in, so it is not kept")
        return
    if has_bluetooth_update(args.build / "app" / "zephyr" / ".config"):
        print("store_binary: this image has Bluetooth updates built in, so it is not kept: "
              "take it from the build directory")
        return

    image = args.build / "app" / "zephyr" / "zephyr.signed.bin"
    if not image.exists():
        sys.exit(f"store_binary: {image} is missing")
    data = image.read_bytes()
    version, name = image_version(data)

    folder = args.repo / "binaries"
    folder.mkdir(exist_ok=True)
    shutil.copyfile(image, folder / f"cranium-{name}.signed.bin")
    shutil.copyfile(image, folder / "latest.signed.bin")
    (folder / "latest.json").write_text(json.dumps({
        "version": version,
        "file": f"cranium-{name}.signed.bin",
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "commit": git_commit(args.repo),
        "command_line": command_line_settings(args.build),
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }, indent=2) + "\n")
    prune(folder)
    print(f"store_binary: {version} is in binaries/ ({len(data)} bytes)")


if __name__ == "__main__":
    main()
