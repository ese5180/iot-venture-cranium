#!/usr/bin/env python3
"""Tests of tools/build_report.py, which the firmware job on GitHub Actions runs. No board, no build.

    python3 firmware/tests/hil/test_build_report.py

A small made-up build folder stands in for a real one: an ELF file with the program headers that
matter, a linker's map file and a devicetree. The numbers in the first test are those of a real build
of firmware 1.6.0, and of what the linker said about it.
"""

import hashlib
import json
import secrets  # noqa: F401  Before tools/ is on the path: tools/secrets.py would hide it.
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOL = REPO / "tools" / "build_report.py"
sys.path.insert(0, str(REPO / "tools"))

import build_report  # noqa: E402

VERSION_FILE = "VERSION_MAJOR = 1\nVERSION_MINOR = 6\nPATCHLEVEL = 0\nVERSION_TWEAK = 0\nEXTRAVERSION =\n"

# (virtual address, load address, size in the file, size in memory), and the region table, as they are
# in the 1.6.0 build. TF-M's first segment starts below its region, and its veneers sit near the end.
MCUBOOT = [(0x0, 0x0, 0xc1e0, 0xc1e0), (0x20000000, 0xc1e0, 0x2b0, 0x2b0), (0xc490, 0xc490, 0x4, 0x4),
           (0x200002b0, 0x200002b0, 0x0, 0x54d8)]
APP = [(0x30000, 0x30000, 0x97c70, 0x97c70), (0x2000c000, 0xc7c70, 0x1808, 0x1808), (0xc9478, 0xc9478, 0x4, 0x4),
       (0x2000d808, 0x2000d808, 0x0, 0x56398)]
TFM = [(0x10000, 0x10000, 0x1c180, 0x1c180), (0x2fc00, 0x2fc00, 0x40, 0x40), (0x20001200, 0x2fc40, 0x38, 0x38),
       (0x20006840, 0x2fc78, 0x160, 0x160), (0x20000000, 0x20000000, 0x0, 0x8f0c)]
MCUBOOT_REGIONS = {"FLASH": (0x0, 0x10000), "RAM": (0x20000000, 0x70000)}
APP_REGIONS = {"FLASH": (0x30000, 0xc1f6a), "RAM": (0x2000c000, 0x64000)}
TFM_REGIONS = {"FLASH": (0x10200, 0x1fe00), "RAM": (0x20000000, 0xc000)}


def make_elf(segments) -> bytes:
    """A 32-bit little-endian ELF file with these loadable segments, and one that is not."""
    all_of_them = [(1, *segment) for segment in segments] + [(4, 0, 0, 0x10, 0x10)]
    header = b"\x7fELF\x01\x01\x01" + bytes(9) + struct.pack("<HHIIIIIHHHHHH", 2, 40, 1, 0, 52, 0, 0, 52, 32, len(all_of_them), 40, 0, 0)
    table = b"".join(struct.pack("<IIIIIIII", kind, 0, vaddr, paddr, file_size, memory_size, 5, 0x1000)
                     for kind, vaddr, paddr, file_size, memory_size in all_of_them)
    return header + table


def make_map(regions) -> str:
    """The part of a GNU ld map file that the report reads, with what surrounds it."""
    lines = ["Archive member included", "", "Memory Configuration", "", "Name             Origin             Length             Attributes"]
    for name, (origin, length) in regions.items():
        lines.append(f"{name:<16} 0x{origin:08x}         0x{length:08x}         xr")
    lines += ["*default*        0x00000000         0xffffffff", "", "Linker script and memory map", "LOAD x.o", ""]
    return "\n".join(lines)


def make_image(version=(1, 6, 0, 0), body=b"\x41" * 2000) -> bytes:
    return (struct.pack("<IIHHIIBBHI", build_report.MCUBOOT_MAGIC, 0x30000, 0x200, 0, len(body), 0x100, *version).ljust(0x200, b"\0")
            + body + b"\x07\x69\x04\x00")


DTS = """\
\t\t\t\t\t/* node '/soc/flash-controller@40039000/flash@0/partitions/partition@10000' defined in here */
\t\t\t\t\tslot0_partition: partition@10000 {
\t\t\t\t\t\tcompatible = "zephyr,mapped-partition"; /* in here */
\t\t\t\t\t\tlabel = "image-0";                      /* in here */
\t\t\t\t\t\treg = < 0x10000 0xe4000 >;              /* in here */
\t\t\t\t\t};
"""


class Folder(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)


class ARealBuild(Folder):
    """The sizes of a real build, against what the linker printed for it."""

    def rows(self, name, segments, regions):
        (self.root / "x.elf").write_bytes(make_elf(segments))
        (self.root / "x.map").write_text(make_map(regions))
        return build_report.image_rows(name, self.root / "x.elf", self.root / "x.map")

    def test_mcuboot_as_the_linker_reports_it(self):
        flash, ram = self.rows("MCUboot", MCUBOOT, MCUBOOT_REGIONS)
        self.assertEqual((flash.used, flash.limit), (50324, 65536))
        self.assertEqual((ram.used, ram.limit), (22408, 448 * 1024))

    def test_the_application_as_the_linker_reports_it(self):
        flash, ram = self.rows("Application", APP, APP_REGIONS)
        self.assertEqual((flash.used, flash.limit), (627836, 794474))
        self.assertEqual((ram.used, ram.limit), (359328, 400 * 1024))

    def test_tfm_as_the_linker_reports_it(self):
        flash, ram = self.rows("TF-M", TFM, TFM_REGIONS)
        self.assertEqual((flash.used, flash.limit), (130008, 130560))
        self.assertEqual((ram.used, ram.limit), (36620, 48 * 1024))

    def test_names_and_order(self):
        rows = self.rows("TF-M", TFM, TFM_REGIONS)
        self.assertEqual([row.name for row in rows], ["TF-M flash", "TF-M RAM"])


class Parsing(Folder):
    def test_the_region_table_is_found_in_a_map_file(self):
        self.assertEqual(build_report.memory_regions(make_map(APP_REGIONS)), APP_REGIONS)

    def test_a_map_file_without_the_table_is_refused(self):
        with self.assertRaisesRegex(build_report.ReportError, "no table of memory regions"):
            build_report.memory_regions("Linker script and memory map\n")

    def test_a_map_file_without_flash_or_ram_is_refused(self):
        (self.root / "x.elf").write_bytes(make_elf(APP))
        (self.root / "x.map").write_text(make_map({"FLASH": (0, 16)}))
        with self.assertRaisesRegex(build_report.ReportError, "no FLASH and RAM"):
            build_report.image_rows("x", self.root / "x.elf", self.root / "x.map")

    def test_only_a_32_bit_little_endian_elf_is_taken(self):
        for data in (b"", b"not an elf", b"\x7fELF\x02\x01" + bytes(64), b"\x7fELF\x01\x02" + bytes(64)):
            with self.subTest(data[:6]), self.assertRaises(build_report.ReportError):
                build_report.load_segments(data)

    def test_a_segment_that_is_not_loaded_counts_for_nothing(self):
        self.assertEqual(build_report.load_segments(make_elf([(1, 2, 3, 4)])), [(1, 2, 3, 4)])

    def test_an_elf_with_nothing_in_flash_is_refused(self):
        (self.root / "x.elf").write_bytes(make_elf([]))
        (self.root / "x.map").write_text(make_map(APP_REGIONS))
        with self.assertRaisesRegex(build_report.ReportError, "nothing in flash"):
            build_report.image_rows("x", self.root / "x.elf", self.root / "x.map")

    def test_the_slot_comes_from_the_devicetree(self):
        (self.root / "zephyr.dts").write_text(DTS)
        self.assertEqual(build_report.slot_size(self.root / "zephyr.dts"), 0xe4000)
        (self.root / "zephyr.dts").write_text("nothing\n")
        with self.assertRaisesRegex(build_report.ReportError, "no slot0_partition"):
            build_report.slot_size(self.root / "zephyr.dts")

    def test_the_header_and_the_version_file_are_written_the_same_way(self):
        self.assertEqual(build_report.header_version(make_image((1, 6, 300, 7))), "1.6.300+7")
        (self.root / "VERSION").write_text(VERSION_FILE)
        self.assertEqual(build_report.version_file(self.root / "VERSION"), "1.6.0+0")
        with self.assertRaisesRegex(build_report.ReportError, "not an MCUboot image"):
            build_report.header_version(b"\0" * 64)
        (self.root / "VERSION").write_text("VERSION_MAJOR = 1\n")
        with self.assertRaisesRegex(build_report.ReportError, "no VERSION_MINOR"):
            build_report.version_file(self.root / "VERSION")


class WholeReport(Folder):
    """A checkout after a build, as the firmware job has it, and the tool as that job runs it."""

    def setUp(self):
        super().setUp()
        self.repo = self.root / "repo"
        (self.repo / "firmware/app").mkdir(parents=True)
        (self.repo / "firmware/app/VERSION").write_text(VERSION_FILE)
        self.git("init", "-q")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "A commit")
        self.commit = self.git("rev-parse", "--short", "HEAD")
        self.build = self.repo / "build"
        for path, segments, regions in (("mcuboot/zephyr/zephyr", MCUBOOT, MCUBOOT_REGIONS), ("app/zephyr/zephyr", APP, APP_REGIONS),
                                        ("app/tfm/bin/tfm_s", TFM, TFM_REGIONS)):
            (self.build / path).parent.mkdir(parents=True, exist_ok=True)
            (self.build / f"{path}.elf").write_bytes(make_elf(segments))
            (self.build / f"{path}.map").write_text(make_map(regions))
        (self.build / "app/zephyr/zephyr.dts").write_text(DTS)
        self.keep(make_image())

    def git(self, *args):
        return subprocess.run(["git", "-c", "user.name=test", "-c", "user.email=test@example.org", "-C", str(self.repo), *args],
                              capture_output=True, text=True, check=True).stdout.strip()

    def keep(self, image, **latest):
        """What tools/store_binary.py does at the end of a build."""
        (self.repo / "binaries").mkdir(exist_ok=True)
        (self.build / "app/zephyr/zephyr.signed.bin").write_bytes(image)
        (self.repo / "binaries/latest.signed.bin").write_bytes(image)
        (self.repo / "binaries/latest.json").write_text(json.dumps({
            "version": "1.6.0+0", "file": "cranium-1.6.0-0.signed.bin", "size": len(image), "sha256": hashlib.sha256(image).hexdigest(),
            "commit": self.commit, "command_line": [], "built": "2026-11-01T00:00:00Z", **latest}))

    def run_tool(self, *more):
        # As the workflow runs it: -I, with nothing of tools/ on the path.
        return subprocess.run([sys.executable, "-I", str(TOOL), "--build", str(self.build), "--repo", str(self.repo), *more],
                              capture_output=True, text=True)

    def test_every_row_is_there_against_its_limit(self):
        result = self.run_tool("--summary", str(self.root / "summary.md"))
        self.assertEqual(result.returncode, 0, result.stderr)
        text = (self.root / "summary.md").read_text()
        self.assertIn(f"Version `1.6.0+0`, commit `{self.commit}`", text)
        self.assertIn("cannot be installed", text)
        self.assertIn("| MCUboot flash | 50324 | 65536 | 76.8% |", text)
        self.assertIn("| MCUboot RAM | 22408 | 458752 | 4.9% |", text)
        self.assertIn("| Application flash | 627836 | 794474 | 79.0% |", text)
        self.assertIn("| Application RAM | 359328 | 409600 | 87.7% |", text)
        self.assertIn("| TF-M flash | 130008 | 130560 | 99.6% |", text)
        self.assertIn("| TF-M RAM | 36620 | 49152 | 74.5% |", text)
        self.assertIn(f"| Signed image | {len(make_image())} | 933888 | 0.3% |", text)
        self.assertIn(text, result.stdout)

    def test_the_summary_is_added_to_and_not_overwritten(self):
        (self.root / "summary.md").write_text("Before\n")
        self.run_tool("--summary", str(self.root / "summary.md"))
        self.assertTrue((self.root / "summary.md").read_text().startswith("Before\n## Firmware build"))

    def test_the_artifact_holds_what_it_says_and_nothing_else(self):
        artifact = self.root / "artifact"
        output = self.root / "output"
        result = self.run_tool("--artifact", str(artifact), "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(path.name for path in artifact.iterdir()), [
            "NOT-INSTALLABLE.txt", "cranium-1.6.0-0-ci-key-not-installable.signed.bin", "latest.json", "sizes.md"])
        self.assertEqual((artifact / "cranium-1.6.0-0-ci-key-not-installable.signed.bin").read_bytes(), make_image())
        note = (artifact / "NOT-INSTALLABLE.txt").read_text()
        self.assertIn("cannot be installed", note)
        self.assertIn(self.commit, note)
        self.assertIn("MCUboot and the", note)
        self.assertEqual(output.read_text(), f"artifact=firmware-1.6.0-0-{self.commit}-ci-key-not-installable\n")

    def test_nothing_over_its_limit_gets_through(self):
        (self.build / "app/zephyr/zephyr.map").write_text(make_map({"FLASH": (0x30000, 627835), "RAM": APP_REGIONS["RAM"]}))
        result = self.run_tool("--summary", str(self.root / "summary.md"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("over the limit: Application flash", result.stderr)
        self.assertIn("100.0% **over**", (self.root / "summary.md").read_text())

    def test_exactly_at_its_limit_is_within_it(self):
        (self.build / "app/zephyr/zephyr.map").write_text(make_map({"FLASH": (0x30000, 627836), "RAM": APP_REGIONS["RAM"]}))
        self.assertEqual(self.run_tool().returncode, 0)

    def test_a_signed_image_too_large_for_the_slot_fails(self):
        image = make_image(body=b"\x41" * 0xe4000)
        self.keep(image)
        result = self.run_tool()
        self.assertEqual(result.returncode, 1)
        self.assertIn("over the limit: Signed image", result.stderr)

    def refused(self, reason):
        result = self.run_tool("--artifact", str(self.root / "artifact"))
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(reason, result.stderr)
        self.assertFalse((self.root / "artifact").exists())

    def test_a_stale_file_in_binaries_cannot_pass_for_this_build(self):
        (self.repo / "binaries/latest.signed.bin").write_bytes(make_image(body=b"\x42" * 2000))
        self.refused("is not the image this build made")

    def test_no_kept_image_is_refused(self):
        (self.repo / "binaries/latest.signed.bin").unlink()
        self.refused("did the build keep its image?")

    def test_latest_json_has_to_describe_this_build_of_this_commit(self):
        for latest, reason in (({"commit": "0000000"}, "commit"), ({"commit": f"{self.commit}+uncommitted"}, "commit"), ({"sha256": "ab" * 32}, "sha256"),
                               ({"size": 1}, "size"), ({"version": "1.5.0+0"}, "version"), ({"command_line": ["x=y"]}, "command_line")):
            with self.subTest(latest):
                self.keep(make_image(), **latest)
                self.refused(f"says {reason} is")

    def test_an_image_of_another_version_than_the_file_is_refused(self):
        self.keep(make_image((1, 6, 1, 0)), version="1.6.1+0")
        self.refused("firmware/app/VERSION says 1.6.0+0")

    def test_an_input_that_is_missing_is_named(self):
        for path in ("app/tfm/bin/tfm_s.elf", "mcuboot/zephyr/zephyr.map", "app/zephyr/zephyr.dts"):
            with self.subTest(path):
                contents = (self.build / path).read_bytes()
                (self.build / path).unlink()
                self.refused(path)
                (self.build / path).write_bytes(contents)

    def test_a_table_is_made_for_every_row_it_is_given(self):
        rows = [build_report.Row("One", 1, 2), build_report.Row("Two", 3, 2)]
        text = build_report.table("1.0.0+0", "abc1234", rows)
        self.assertIn("| One | 1 | 2 | 50.0% |", text)
        self.assertIn("| Two | 3 | 2 | 150.0% **over** |", text)


if __name__ == "__main__":
    unittest.main()
