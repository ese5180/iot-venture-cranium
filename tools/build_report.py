#!/usr/bin/env python3
"""What a build came to, each size against its limit. Run by the firmware job on GitHub Actions.

    python3 -I tools/build_report.py --build build --repo . [--summary file] [--artifact folder] [--output file]

It takes each limit from the build itself: flash and RAM from the region table in the linker's map
file, and the signed image's from slot0_partition in the devicetree. It reads the used sizes from
the ELF files. It fails if anything is over its limit, or if what binaries/ holds is not what this
build made from this commit, so that a stale file cannot pass for this build.

--summary appends the table to that file, as Markdown. --artifact puts the image, latest.json, the
table and a note in that folder. Images built on GitHub Actions are signed with a throwaway key, so
that folder is named and marked as not installable. --output appends artifact=<name> to that file.

-I, because tools/ holds a secrets.py that must not hide the standard library's module. Nothing here
needs the SDK.
"""

import argparse
import hashlib
import json
import re
import struct
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

MCUBOOT_MAGIC = 0x96f3b83d
PT_LOAD = 1

NOT_INSTALLABLE = """\
This image cannot be installed on a board.

GitHub Actions built it from commit {commit} and signed it with a key made for that one job and then
thrown away. The boards and the firmware console trust only the project's own key, so MCUboot and the
console both refuse this image. It exists to show that the commit builds and how large it is.

A release that can be installed is signed by the person who holds the key. See docs/ci.md.
"""


class ReportError(Exception):
    """Why this build cannot be reported."""


@dataclass(frozen=True)
class Row:
    name: str
    used: int
    limit: int

    @property
    def over(self) -> bool:
        return self.used > self.limit


def memory_regions(map_text: str) -> dict[str, tuple[int, int]]:
    """The linker's table of memory regions in a map file: name to origin and length."""
    match = re.search(r"^Memory Configuration\n\nName +Origin +Length.*\n((?:.+\n)+)", map_text, re.MULTILINE)
    if match is None:
        raise ReportError("the map file has no table of memory regions")
    regions = {}
    for line in match.group(1).splitlines():
        fields = line.split()
        if len(fields) >= 3 and not fields[0].startswith("*"):
            regions[fields[0]] = (int(fields[1], 16), int(fields[2], 16))
    return regions


def load_segments(elf: bytes) -> list[tuple[int, int, int, int]]:
    """What a 32-bit little-endian ELF loads: virtual address, load address, file size and memory size."""
    if elf[:6] != b"\x7fELF\x01\x01":
        raise ReportError("not a 32-bit little-endian ELF file")
    offset, = struct.unpack_from("<I", elf, 28)
    entry_size, count = struct.unpack_from("<HH", elf, 42)
    segments = []
    for index in range(count):
        kind, _, vaddr, paddr, file_size, memory_size = struct.unpack_from("<IIIIII", elf, offset + index * entry_size)
        if kind == PT_LOAD:
            segments.append((vaddr, paddr, file_size, memory_size))
    return segments


def used_in(segments, flash: tuple[int, int], ram: tuple[int, int]) -> tuple[int, int]:
    """As the linker reports it: from the start of a region to the end of what it placed there. So
    TF-M looks nearly full, because its veneers sit at a fixed place near the end of its flash.
    Flash holds what is loaded from it, and RAM what runs in it, zeroed data included."""
    def used(region, parts):
        start, length = region
        ends = [address + size for address, size in parts
                if size > 0 and address < start + length and address + size > start]
        return max(ends) - start if ends else 0

    return (used(flash, [(paddr, file_size) for _, paddr, file_size, _ in segments]),
            used(ram, [(vaddr, memory_size) for vaddr, _, _, memory_size in segments]))


def image_rows(name: str, elf: Path, map_file: Path) -> list[Row]:
    for path in (elf, map_file):
        if not path.is_file():
            raise ReportError(f"{path} is missing")
    regions = memory_regions(map_file.read_text(errors="replace"))
    if "FLASH" not in regions or "RAM" not in regions:
        raise ReportError(f"{map_file} has no FLASH and RAM regions")
    flash_used, ram_used = used_in(load_segments(elf.read_bytes()), regions["FLASH"], regions["RAM"])
    if flash_used == 0:
        raise ReportError(f"{elf} puts nothing in flash")
    return [Row(f"{name} flash", flash_used, regions["FLASH"][1]), Row(f"{name} RAM", ram_used, regions["RAM"][1])]


def slot_size(dts: Path) -> int:
    """The application slot in the devicetree that the build used."""
    if not dts.is_file():
        raise ReportError(f"{dts} is missing")
    match = re.search(r"\bslot0_partition: partition@[0-9a-f]+ \{.*?\breg = < 0x[0-9a-f]+ (0x[0-9a-f]+) >", dts.read_text(), re.DOTALL)
    if match is None:
        raise ReportError(f"{dts} has no slot0_partition")
    return int(match.group(1), 16)


def header_version(data: bytes) -> str:
    """The version in an MCUboot header, as store_binary.py writes it."""
    if len(data) < 32 or int.from_bytes(data[0:4], "little") != MCUBOOT_MAGIC:
        raise ReportError("this is not an MCUboot image")
    return f"{data[20]}.{data[21]}.{int.from_bytes(data[22:24], 'little')}+{int.from_bytes(data[24:28], 'little')}"


def version_file(path: Path) -> str:
    """firmware/app/VERSION, in the same form."""
    fields = dict(re.findall(r"^(\w+) *= *(\w*)$", path.read_text(), re.MULTILINE))
    try:
        return f"{fields['VERSION_MAJOR']}.{fields['VERSION_MINOR']}.{fields['PATCHLEVEL']}+{fields['VERSION_TWEAK']}"
    except KeyError as error:
        raise ReportError(f"{path} has no {error.args[0]}") from error


def head_commit(repo: Path) -> str:
    try:
        return subprocess.run(["git", "-C", str(repo), "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise ReportError(f"git cannot say what {repo} is: {error}") from error


def check_kept_image(build: Path, repo: Path) -> tuple[bytes, dict]:
    """What binaries/ holds has to be this build of this commit, and nothing older."""
    built = build / "app" / "zephyr" / "zephyr.signed.bin"
    kept = repo / "binaries" / "latest.signed.bin"
    latest_file = repo / "binaries" / "latest.json"
    for path in (built, kept, latest_file):
        if not path.is_file():
            raise ReportError(f"{path} is missing: did the build keep its image?")
    data = built.read_bytes()
    if kept.read_bytes() != data:
        raise ReportError("binaries/latest.signed.bin is not the image this build made")
    latest = json.loads(latest_file.read_text())
    version = header_version(data)
    expected = {
        "version": version,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "commit": head_commit(repo),
        "command_line": [],
    }
    for key, value in expected.items():
        if latest.get(key) != value:
            raise ReportError(f"binaries/latest.json says {key} is {latest.get(key)!r}, and this build's is {value!r}")
    wanted = version_file(repo / "firmware" / "app" / "VERSION")
    if version != wanted:
        raise ReportError(f"the image's header says {version}, and firmware/app/VERSION says {wanted}")
    return data, latest


def table(version: str, commit: str, rows: list[Row]) -> str:
    lines = [
        "## Firmware build",
        "",
        f"Version `{version}`, commit `{commit}`. Signed with a throwaway key: this image cannot be installed.",
        "",
        "| What | Used (bytes) | Limit (bytes) | Used of the limit |",
        "| --- | ---: | ---: | ---: |",
    ]
    for row in rows:
        lines.append(f"| {row.name} | {row.used} | {row.limit} | {row.used / row.limit:.1%}{' **over**' if row.over else ''} |")
    return "\n".join(lines) + "\n"


def write_artifact(folder: Path, version: str, commit: str, image: bytes, latest: dict, report: str) -> str:
    """The folder that gets uploaded, with nothing in it but what is named here. Returns its name."""
    name = version.replace("+", "-")
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"cranium-{name}-ci-key-not-installable.signed.bin").write_bytes(image)
    (folder / "latest.json").write_text(json.dumps(latest, indent=2) + "\n")
    (folder / "sizes.md").write_text(report)
    (folder / "NOT-INSTALLABLE.txt").write_text(NOT_INSTALLABLE.format(commit=commit))
    return f"firmware-{name}-{commit}-ci-key-not-installable"


def report(build: Path, repo: Path, summary: Path | None, artifact: Path | None, output: Path | None) -> int:
    image, latest = check_kept_image(build, repo)
    version, commit = latest["version"], latest["commit"]
    rows = [
        *image_rows("MCUboot", build / "mcuboot/zephyr/zephyr.elf", build / "mcuboot/zephyr/zephyr.map"),
        *image_rows("Application", build / "app/zephyr/zephyr.elf", build / "app/zephyr/zephyr.map"),
        *image_rows("TF-M", build / "app/tfm/bin/tfm_s.elf", build / "app/tfm/bin/tfm_s.map"),
        Row("Signed image", len(image), slot_size(build / "app/zephyr/zephyr.dts")),
    ]
    text = table(version, commit, rows)
    print(text)
    if summary is not None:
        with summary.open("a") as file:
            file.write(text)
    if artifact is not None:
        name = write_artifact(artifact, version, commit, image, latest, text)
        if output is not None:
            with output.open("a") as file:
                file.write(f"artifact={name}\n")
    over = [row.name for row in rows if row.over]
    if over:
        print(f"build_report: over the limit: {', '.join(over)}", file=sys.stderr)
        return 1
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--build", required=True, type=Path, help="the sysbuild build directory")
    parser.add_argument("--repo", required=True, type=Path, help="the root of the checkout")
    parser.add_argument("--summary", type=Path, help="append the table to this file")
    parser.add_argument("--artifact", type=Path, help="write what is to be uploaded to this folder")
    parser.add_argument("--output", type=Path, help="append artifact=<name> to this file")
    args = parser.parse_args()
    try:
        sys.exit(report(args.build, args.repo, args.summary, args.artifact, args.output))
    except ReportError as error:
        sys.exit(f"build_report: {error}")


if __name__ == "__main__":
    main()
