#!/usr/bin/env python3
"""Tests of tools/golden.py and of firmware/tests/hil/golden_bench.py's machinery. No board.

    python3 firmware/tests/hil/test_golden.py

Run from an nRF Connect SDK terminal, which provides pyserial, cbor2 and imgtool. Where the SDK's
own files are the evidence (the nRF5340's registers, MCUboot's log lines, imgtool itself), a test
reads them through ZEPHYR_BASE, and is skipped without it.

These show what the tool refuses and what the bench sends. What a real board does with it is for
firmware/tests/hil/golden_bench.py to find out.
"""

import contextlib
import hashlib
import io
import json
import os
import re
import secrets  # noqa: F401  Before tools/ is on the path: tools/secrets.py would hide it.
import stat
import struct
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import golden  # noqa: E402
import golden_bench  # noqa: E402
import store_binary  # noqa: E402
import test_recover  # noqa: E402
from ota_bench import TestFailed as BenchFailed  # noqa: E402

ZEPHYR_BASE = os.environ.get("ZEPHYR_BASE")
FIRMWARE = REPO / "firmware" / "app"
GOLDEN_C = FIRMWARE / "sysbuild/mcuboot/golden/src/golden.c"
GUARD_C = FIRMWARE / "sysbuild/mcuboot/golden/src/image_number_guard.c"


def make_image(body: bytes = bytes(range(1, 251)) * 8, version=(1, 4, 1, 0), protected: bool = False) -> bytes:
    """An image laid out as imgtool lays one out. Its signature is made up."""
    header_size = 0x200
    tlv_protected = b""
    if protected:
        tlv_protected = struct.pack("<HH", golden.TLV_PROTECTED_INFO_MAGIC, 12) + struct.pack("<BxH", 0x50, 4) + b"\0" * 4
    header = struct.pack("<IIHHII", golden.MCUBOOT_MAGIC, 0x30000, header_size, len(tlv_protected),
                         len(body), 0) + struct.pack("<BBHI", *version) + b"\0" * 4
    signed = header.ljust(header_size, b"\0") + body + tlv_protected
    digest = hashlib.sha256(signed).digest()
    signature = b"\x30\x44\x02\x20" + b"\x5a" * 32 + b"\x02\x20" + b"\xa5" * 32
    entries = (struct.pack("<BxH", golden.TLV_SHA256, 32) + digest
               + struct.pack("<BxH", golden.TLV_KEY_HASH, 32) + b"\x11" * 32
               + struct.pack("<BxH", golden.TLV_ECDSA_SIGNATURE, len(signature)) + signature)
    return signed + struct.pack("<HH", golden.TLV_INFO_MAGIC, len(entries) + 4) + entries


class ParseImageTest(unittest.TestCase):
    def test_what_an_image_says_about_itself(self):
        data = make_image()
        image = golden.parse_image(data)
        self.assertEqual(image.version, "1.4.1+0")
        self.assertEqual(image.file_name_version, "1.4.1-0")
        self.assertEqual(image.size, len(data))
        self.assertEqual(image.hash_tlv, image.computed_hash)
        self.assertEqual(image.key_hash_tlv, "11" * 32)
        self.assertEqual(image.file_sha256, hashlib.sha256(data).hexdigest())
        golden.check_image_alone(image, len(data))

    def test_the_hash_covers_protected_metadata_too(self):
        data = make_image(protected=True)
        image = golden.parse_image(data)
        self.assertEqual(image.hash_tlv, image.computed_hash)

    def test_the_hash_does_not_cover_the_signature(self):
        data = bytearray(make_image())
        image = golden.parse_image(bytes(data))
        data[image.signature_offset + 40] ^= 1
        changed = golden.parse_image(bytes(data))
        self.assertEqual(changed.hash_tlv, image.hash_tlv)
        self.assertEqual(changed.computed_hash, image.computed_hash)
        self.assertNotEqual(changed.file_sha256, image.file_sha256)

    def test_a_flip_in_the_body_is_seen_without_any_key(self):
        data = bytearray(make_image())
        data[0x210] ^= 1
        image = golden.parse_image(bytes(data))
        with self.assertRaisesRegex(golden.GoldenError, "does not match its own hash"):
            golden.check_image_alone(image, len(data))

    def test_things_that_are_not_an_image(self):
        for name, data in (("short", b"abc"), ("magic", b"\0" * 64), ("cut", make_image()[:0x300]),
                           ("end", make_image()[:-1])):
            with self.subTest(name), self.assertRaises(golden.GoldenError):
                golden.parse_image(data)

    def test_trailing_bytes_are_not_part_of_it(self):
        data = make_image() + b"\xff" * 8
        with self.assertRaisesRegex(golden.GoldenError, "the file is"):
            golden.check_image_alone(golden.parse_image(data), len(data))

    def test_an_image_too_large_for_the_partition(self):
        image = golden.parse_image(make_image())
        too_large = golden.Image(**{**image.__dict__, "size": golden.PARTITION_SIZE + 1})
        with self.assertRaisesRegex(golden.GoldenError, "does not fit"):
            golden.check_image_alone(too_large, too_large.size)


class OffsetsTest(unittest.TestCase):
    def test_each_offset_is_where_it_says_and_has_a_bit_to_clear(self):
        # A body with zeros at its middle: the offset moves on to a byte it can use.
        body = bytes(1000) + b"\x7f" * 1000
        data = make_image(body)
        image = golden.parse_image(data)
        offsets = golden.flip_offsets(data)
        self.assertGreaterEqual(offsets["body"], image.header_size)
        self.assertLess(offsets["body"], image.header_size + image.body_size)
        self.assertNotEqual(data[offsets["body"]], 0)
        self.assertGreaterEqual(offsets["signature"], image.signature_offset)
        self.assertLess(offsets["signature"], image.signature_offset + image.signature_length)
        self.assertNotEqual(data[offsets["signature"]], 0)

    def test_a_flip_in_the_signature_leaves_the_hash_alone_and_the_asn1_whole(self):
        data = make_image()
        image = golden.parse_image(data)
        offset = golden.flip_offsets(data)["signature"]
        # After the second integer's header: the structure of the signature stays as it is.
        self.assertGreater(offset, image.signature_offset + 2 + 2 + 32 + 2)
        damaged = golden_bench.flipped(data, offset)
        self.assertEqual(golden.parse_image(damaged).computed_hash, image.hash_tlv)
        self.assertNotEqual(damaged, data)

    def test_a_flip_clears_one_bit_as_the_fault_image_does(self):
        data = b"\x00\x06"
        self.assertEqual(golden_bench.flipped(data, 1), b"\x00\x04")

    def test_a_flip_in_the_body_changes_the_hash(self):
        data = make_image()
        damaged = golden_bench.flipped(data, golden.flip_offsets(data)["body"])
        image = golden.parse_image(damaged)
        self.assertNotEqual(image.computed_hash, image.hash_tlv)


class PinLinesTest(unittest.TestCase):
    TEXT = "CONFIG_A=y\n\n# The golden image.\nCONFIG_CRANIUM_GOLDEN=n\n\nCONFIG_B=y\n"

    def test_setting_the_pin_takes_the_place_of_the_off_line(self):
        text = golden.set_pin(self.TEXT, "ab" * 32, 1234)
        self.assertEqual(text, "CONFIG_A=y\n\n# The golden image.\nCONFIG_CRANIUM_GOLDEN=y\n"
                               f'CONFIG_CRANIUM_GOLDEN_SHA256="{"ab" * 32}"\n'
                               "CONFIG_CRANIUM_GOLDEN_SIZE=1234\n\nCONFIG_B=y\n")
        self.assertEqual(golden.read_pin(text), (True, "ab" * 32, 1234))

    def test_setting_it_again_leaves_one_set_of_lines(self):
        text = golden.set_pin(golden.set_pin(self.TEXT, "ab" * 32, 1234), "cd" * 32, 5678)
        self.assertEqual(golden.read_pin(text), (True, "cd" * 32, 5678))
        self.assertEqual(text.count("CONFIG_CRANIUM_GOLDEN=y"), 1)
        self.assertNotIn("ab" * 32, text)

    def test_off_is_off(self):
        self.assertEqual(golden.read_pin(self.TEXT), (False, None, None))

    def test_a_configuration_without_the_line_is_not_guessed_at(self):
        with self.assertRaisesRegex(golden.GoldenError, "no CONFIG_CRANIUM_GOLDEN"):
            golden.set_pin("CONFIG_A=y\n", "ab" * 32, 1234)

    def test_a_setting_made_twice_is_not_guessed_at(self):
        # Kconfig takes the last one, so reading the first would agree with a pin the build does not use.
        one = golden.set_pin(self.TEXT, "ab" * 32, 100)
        for name, extra in (("_SHA256", f'CONFIG_CRANIUM_GOLDEN_SHA256="{"cd" * 32}"\n'),
                            ("_SIZE", "CONFIG_CRANIUM_GOLDEN_SIZE=200\n"),
                            ("", "CONFIG_CRANIUM_GOLDEN=n\n")):
            with self.subTest(name), self.assertRaisesRegex(golden.GoldenError,
                                                            f"CONFIG_CRANIUM_GOLDEN{name} more than once"):
                golden.read_pin(one + extra)

    def test_a_comment_about_a_setting_is_not_a_setting(self):
        text = golden.set_pin(self.TEXT, "ab" * 32, 100) + "# CONFIG_CRANIUM_GOLDEN_SIZE=200\n"
        self.assertEqual(golden.read_pin(text), (True, "ab" * 32, 100))


class ACheckout:
    """A real git repository, with what freeze and check look at."""

    def __init__(self, folder: Path):
        self.root = folder
        self.checkout = golden.Checkout(folder)
        self.checkout.prj_conf.parent.mkdir(parents=True)
        self.checkout.prj_conf.write_text("CONFIG_A=y\nCONFIG_CRANIUM_GOLDEN=n\n")
        self.checkout.public_key.parent.mkdir(parents=True)
        self.checkout.public_key.write_text("public key\n")
        (folder / "binaries").mkdir()
        (folder / ".gitignore").write_text("/binaries/*\n")
        self.git("init", "-q")
        self.commit("first")

    def git(self, *arguments: str) -> str:
        return subprocess.run(["git", "-c", "user.name=test", "-c", "user.email=test@example.com",
                               "-C", str(self.root), *arguments],
                              check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, message: str) -> None:
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)

    def built(self, data: bytes | None = None, uncommitted: bool = False,
              command_line: tuple[str, ...] = ()) -> Path:
        """What a build of this checkout leaves in binaries/."""
        data = data if data is not None else make_image()
        image = golden.parse_image(data)
        path = self.root / "binaries" / f"cranium-{image.file_name_version}.signed.bin"
        path.write_bytes(data)
        commit = self.git("rev-parse", "--short", "HEAD") + ("+uncommitted" if uncommitted else "")
        self.checkout.latest.write_text(json.dumps({"version": image.version, "file": path.name,
                                                    "sha256": image.file_sha256, "commit": commit,
                                                    "command_line": list(command_line)}))
        return path


class FreezeTestCase(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.repo = ACheckout(Path(folder.name))
        self.checkout = self.repo.checkout
        for target, value in (("verify_signature", None), ("sdk_version", "3.4.0")):
            patcher = mock.patch.object(golden, target, return_value=value)
            setattr(self, target, patcher.start())
            self.addCleanup(patcher.stop)

    def frozen(self, **arguments) -> dict:
        return golden.freeze(self.checkout, self.repo.built(), **arguments)

    def assert_nothing_written(self) -> None:
        self.assertFalse(self.checkout.manifest.exists())
        self.assertFalse(self.checkout.frozen.exists())
        self.assertIn("CONFIG_CRANIUM_GOLDEN=n", self.checkout.prj_conf.read_text())


class FreezeTest(FreezeTestCase):
    def test_it_writes_what_the_design_asks_for(self):
        path = self.repo.built()
        image = golden.parse_image(path.read_bytes())
        manifest = golden.freeze(self.checkout, path)

        on_disk = json.loads(self.checkout.manifest.read_text())
        self.assertEqual(on_disk, manifest)
        self.assertEqual(manifest["version"], "1.4.1+0")
        self.assertEqual(manifest["file"], path.name)
        self.assertEqual(manifest["file_sha256"], image.file_sha256)
        self.assertEqual(manifest["hash_tlv"], image.hash_tlv)
        self.assertEqual(manifest["key_hash_tlv"], image.key_hash_tlv)
        self.assertEqual(manifest["size"], image.size)
        self.assertEqual(manifest["commit"], self.repo.git("rev-parse", "--short", "HEAD"))
        self.assertEqual(manifest["sdk"], "3.4.0")
        self.assertIsNone(manifest[golden.QUALIFYING_RUN])
        self.assertEqual((self.checkout.frozen / path.name).read_bytes(), path.read_bytes())
        self.assertEqual(golden.read_pin(self.checkout.prj_conf.read_text()),
                         (True, image.hash_tlv, image.size))
        self.assertIn("CONFIG_A=y", self.checkout.prj_conf.read_text())
        self.verify_signature.assert_called_once_with(path, self.checkout.public_key, image.hash_tlv)

    def test_a_uncommitted_image_is_refused(self):
        with self.assertRaisesRegex(golden.GoldenError, "uncommitted"):
            golden.freeze(self.checkout, self.repo.built(uncommitted=True))
        self.assert_nothing_written()

    def test_a_changed_tracked_file_is_refused_anywhere_in_the_tree(self):
        for name in ("firmware/app/sysbuild/mcuboot/prj.conf", ".gitignore"):
            with self.subTest(name):
                path = self.repo.root / name
                original = path.read_text()
                path.write_text(original + "# changed\n")
                with self.assertRaisesRegex(golden.GoldenError, "uncommitted changes"):
                    golden.freeze(self.checkout, self.repo.built())
                path.write_text(original)
        self.assert_nothing_written()

    def test_a_new_file_under_firmware_is_refused(self):
        (self.repo.root / "firmware" / "new.c").write_text("int x;\n")
        with self.assertRaisesRegex(golden.GoldenError, "new.c"):
            golden.freeze(self.checkout, self.repo.built())
        self.assert_nothing_written()

    def test_a_new_file_elsewhere_changes_no_image(self):
        (self.repo.root / "a manual.pdf").write_text("notes\n")
        self.assertEqual(self.frozen()["version"], "1.4.1+0")

    def test_only_the_newest_build_of_this_checkout_can_be_frozen(self):
        path = self.repo.built(make_image(version=(1, 4, 0, 0)))
        self.repo.built(make_image(version=(1, 4, 1, 0)))
        with self.assertRaisesRegex(golden.GoldenError, "another build"):
            golden.freeze(self.checkout, path)
        self.assert_nothing_written()

    def test_no_record_of_the_build_is_refused(self):
        path = self.repo.built()
        self.checkout.latest.unlink()
        with self.assertRaisesRegex(golden.GoldenError, "latest.json is missing"):
            golden.freeze(self.checkout, path)
        self.assert_nothing_written()

    def test_an_unknown_commit_is_refused(self):
        path = self.repo.built()
        latest = json.loads(self.checkout.latest.read_text())
        for commit in ("unknown", "1234567"):
            with self.subTest(commit):
                latest["commit"] = commit
                self.checkout.latest.write_text(json.dumps(latest))
                with self.assertRaisesRegex(golden.GoldenError, "commit"):
                    golden.freeze(self.checkout, path)
        self.assert_nothing_written()

    def test_settings_from_the_command_line_are_refused(self):
        path = self.repo.built(command_line=("app_CONFIG_APP_WATCHDOG_TIMEOUT_SECONDS=30",))
        with self.assertRaisesRegex(golden.GoldenError, "WATCHDOG_TIMEOUT_SECONDS=30.*--pristine"):
            golden.freeze(self.checkout, path)
        self.assert_nothing_written()

    def test_a_build_with_no_record_of_its_settings_is_refused(self):
        path = self.repo.built()
        latest = json.loads(self.checkout.latest.read_text())
        del latest["command_line"]
        self.checkout.latest.write_text(json.dumps(latest))
        with self.assertRaisesRegex(golden.GoldenError, "how this image was configured"):
            golden.freeze(self.checkout, path)
        self.assert_nothing_written()

    def test_an_image_from_an_earlier_commit_is_refused_unless_asked_for(self):
        path = self.repo.built()
        (self.repo.root / "firmware" / "later.txt").write_text("a later change\n")
        self.repo.commit("later")
        with self.assertRaisesRegex(golden.GoldenError, "moved on.*--older-commit"):
            golden.freeze(self.checkout, path)
        self.assert_nothing_written()
        self.assertEqual(golden.freeze(self.checkout, path, older_commit=True)["version"], "1.4.1+0")

    def test_a_damaged_image_is_refused_before_anything_else(self):
        data = bytearray(make_image())
        data[0x210] ^= 1
        path = self.repo.root / "binaries" / "damaged.bin"
        path.write_bytes(data)
        with self.assertRaisesRegex(golden.GoldenError, "its own hash"):
            golden.freeze(self.checkout, path)
        self.assert_nothing_written()

    def test_a_refused_signature_writes_nothing(self):
        self.verify_signature.side_effect = golden.GoldenError("imgtool refuses the image")
        with self.assertRaisesRegex(golden.GoldenError, "imgtool refuses"):
            self.frozen()
        self.assert_nothing_written()

    def test_a_frozen_image_is_not_replaced_by_accident(self):
        self.frozen()
        self.repo.commit("frozen")
        newer = self.repo.built(make_image(version=(1, 5, 0, 0)))
        with self.assertRaisesRegex(golden.GoldenError, "--replace"):
            golden.freeze(self.checkout, newer)
        self.assertEqual(self.checkout.read_manifest()["version"], "1.4.1+0")

        manifest = golden.freeze(self.checkout, newer, replace=True)
        self.assertEqual(manifest["version"], "1.5.0+0")
        self.assertEqual(golden.read_pin(self.checkout.prj_conf.read_text())[1], manifest["hash_tlv"])

    def test_the_same_image_twice_is_said_to_be_frozen_already(self):
        self.frozen()
        self.repo.commit("frozen")
        with self.assertRaisesRegex(golden.GoldenError, "frozen already"):
            golden.freeze(self.checkout, self.repo.built())


@unittest.skipUnless(ZEPHYR_BASE, "needs imgtool from the SDK, through ZEPHYR_BASE")
class ImgtoolTest(unittest.TestCase):
    """A real image from the real tool, with a throwaway key, and the real check on it."""

    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        folder = Path(cls.folder.name)
        tool = Path(ZEPHYR_BASE).parent / "bootloader/mcuboot/scripts/imgtool.py"
        cls.key = folder / "throwaway.pem"
        cls.other = folder / "other.pem"
        cls.signed = folder / "signed.bin"
        for key in (cls.key, cls.other):
            subprocess.run([sys.executable, str(tool), "keygen", "-t", "ecdsa-p256", "-k", str(key)],
                           check=True, capture_output=True)
        raw = folder / "raw.bin"
        raw.write_bytes(bytes(range(1, 251)) * 40)
        subprocess.run([sys.executable, str(tool), "sign", "--key", str(cls.key), "--version", "1.4.1+0",
                        "--slot-size", "0xe4000", "--header-size", "0x200", "--pad-header", "--align", "4",
                        "--rom-fixed", "0x30000", str(raw), str(cls.signed)], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()

    def test_our_parser_reads_what_imgtool_writes(self):
        data = self.signed.read_bytes()
        image = golden.parse_image(data)
        self.assertEqual(image.version, "1.4.1+0")
        golden.check_image_alone(image, len(data))

    def test_the_right_key_verifies(self):
        image = golden.parse_image(self.signed.read_bytes())
        golden.verify_signature(self.signed, self.key, image.hash_tlv)

    def test_another_key_is_refused(self):
        image = golden.parse_image(self.signed.read_bytes())
        with self.assertRaisesRegex(golden.GoldenError, "imgtool refuses"):
            golden.verify_signature(self.signed, self.other, image.hash_tlv)

    def test_a_flipped_signature_is_refused(self):
        data = self.signed.read_bytes()
        image = golden.parse_image(data)
        bad = Path(self.folder.name) / "flipped.bin"
        bad.write_bytes(golden_bench.flipped(data, golden.flip_offsets(data)["signature"]))
        with self.assertRaisesRegex(golden.GoldenError, "imgtool refuses"):
            golden.verify_signature(bad, self.key, image.hash_tlv)

    def test_the_frozen_key_verifies_the_kept_image_if_there_is_one(self):
        kept = REPO / "binaries" / "cranium-1.3.0-0.signed.bin"
        if not kept.exists():
            self.skipTest("no 1.3.0 in binaries/")
        image = golden.parse_image(kept.read_bytes())
        golden.verify_signature(kept, REPO / "firmware/keys/fw_signing_pub.pem", image.hash_tlv)

    def test_the_sdk_version_is_found(self):
        self.assertRegex(golden.sdk_version(), r"^\d+\.\d+\.\d+$")


class QualifyTest(FreezeTestCase):
    def test_a_bench_run_can_be_recorded_after_the_freeze(self):
        before = self.frozen()
        self.assertIsNone(before[golden.QUALIFYING_RUN])
        self.repo.commit("frozen")

        after = golden.qualify(self.checkout, "build-hil/results.jsonl, 2026-11-02, update faulty")
        self.assertEqual(after[golden.QUALIFYING_RUN], "build-hil/results.jsonl, 2026-11-02, update faulty")
        self.assertEqual({k: v for k, v in after.items() if k != golden.QUALIFYING_RUN},
                         {k: v for k, v in before.items() if k != golden.QUALIFYING_RUN})
        self.assertEqual(self.checkout.read_manifest(), after)
        # What it recorded changes nothing that check compares.
        golden.check(self.checkout)

    def test_it_can_also_come_with_the_freeze(self):
        self.assertEqual(self.frozen(qualifying_run="earlier run")[golden.QUALIFYING_RUN], "earlier run")

    def test_it_needs_something_frozen(self):
        with self.assertRaisesRegex(golden.GoldenError, "nothing has been frozen"):
            golden.qualify(self.checkout, "a run")

    def test_it_needs_a_name(self):
        self.frozen()
        with self.assertRaisesRegex(golden.GoldenError, "which bench run"):
            golden.qualify(self.checkout, "   ")

    def run_main(self, *arguments) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = golden.main(list(arguments), self.checkout)
        return code, out.getvalue(), err.getvalue()

    def test_check_says_so_and_can_insist_on_it(self):
        self.frozen()
        code, out, _ = self.run_main("check")
        self.assertEqual(code, 0)
        self.assertIn("No bench run is recorded", out)

        code, _, err = self.run_main("check", "--qualified")
        self.assertEqual(code, 1)
        self.assertIn("no bench run", err)

        self.assertEqual(self.run_main("qualify", "the regression")[0], 0)
        code, out, _ = self.run_main("check", "--qualified")
        self.assertEqual(code, 0)
        self.assertIn("Qualified by: the regression", out)


class CheckTest(FreezeTestCase):
    def setUp(self):
        super().setUp()
        self.manifest = self.frozen()
        self.path = self.checkout.frozen_image(self.manifest)

    def test_everything_agrees(self):
        manifest, data = golden.check(self.checkout)
        self.assertEqual(manifest, self.manifest)
        self.assertEqual(data, self.path.read_bytes())

    def test_nothing_frozen(self):
        self.checkout.manifest.unlink()
        with self.assertRaisesRegex(golden.GoldenError, "nothing has been frozen"):
            golden.check(self.checkout)

    def test_a_manifest_with_a_field_missing(self):
        manifest = dict(self.manifest)
        del manifest["hash_tlv"]
        self.checkout.write_manifest(manifest)
        with self.assertRaisesRegex(golden.GoldenError, "hash_tlv"):
            golden.check(self.checkout)

    def test_the_bootloader_set_to_off(self):
        self.checkout.prj_conf.write_text("CONFIG_CRANIUM_GOLDEN=n\n")
        with self.assertRaisesRegex(golden.GoldenError, "turned on"):
            golden.check(self.checkout)

    def test_another_pin_in_the_bootloader(self):
        self.checkout.prj_conf.write_text(golden.set_pin(self.checkout.prj_conf.read_text(), "ee" * 32,
                                                         self.manifest["size"]))
        with self.assertRaisesRegex(golden.GoldenError, "pins"):
            golden.check(self.checkout)

    def test_another_size_in_the_bootloader(self):
        self.checkout.prj_conf.write_text(golden.set_pin(self.checkout.prj_conf.read_text(),
                                                         self.manifest["hash_tlv"], 12))
        with self.assertRaisesRegex(golden.GoldenError, "12 bytes"):
            golden.check(self.checkout)

    def test_a_built_configuration_with_the_same_pin_agrees(self):
        config = self.repo.root / "built.config"
        config.write_text("# built\nCONFIG_OTHER=y\n" + golden.set_pin("CONFIG_CRANIUM_GOLDEN=n\n", self.manifest["hash_tlv"],
                                                                        self.manifest["size"]))
        golden.check(self.checkout, built_config=config)

    def test_a_built_configuration_that_differs_is_refused(self):
        config = self.repo.root / "built.config"
        for name, text in (("off", "# CONFIG_CRANIUM_GOLDEN is not set\n"),
                           ("another pin", golden.set_pin("CONFIG_CRANIUM_GOLDEN=n\n", "ee" * 32, self.manifest["size"])),
                           ("another size", golden.set_pin("CONFIG_CRANIUM_GOLDEN=n\n", self.manifest["hash_tlv"], 12))):
            with self.subTest(name):
                config.write_text(text)
                with self.assertRaisesRegex(golden.GoldenError, "was built with"):
                    golden.check(self.checkout, built_config=config)

    def test_main_takes_a_built_configuration(self):
        config = self.repo.root / "built.config"
        config.write_text("# CONFIG_CRANIUM_GOLDEN is not set\n")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(golden.main(["check", "--config", str(config)], self.checkout), 1)
        self.assertIn("was built with", err.getvalue())

    def test_the_file_is_missing(self):
        self.path.unlink()
        with self.assertRaisesRegex(golden.GoldenError, "is missing") as caught:
            golden.check(self.checkout)
        # The console has no way to give a file back.
        self.assertNotIn("console", str(caught.exception))

    def test_a_flipped_body(self):
        data = self.path.read_bytes()
        self.path.write_bytes(golden_bench.flipped(data, golden.flip_offsets(data)["body"]))
        with self.assertRaisesRegex(golden.GoldenError, "its own hash"):
            golden.check(self.checkout)

    def test_a_flipped_signature_passes_its_own_hash_and_still_fails(self):
        data = self.path.read_bytes()
        self.path.write_bytes(golden_bench.flipped(data, golden.flip_offsets(data)["signature"]))
        with self.assertRaisesRegex(golden.GoldenError, "not the file that was frozen"):
            golden.check(self.checkout)

    def test_another_good_image_under_that_name(self):
        self.path.write_bytes(make_image(version=(1, 3, 0, 0)))
        with self.assertRaisesRegex(golden.GoldenError, "not the file that was frozen"):
            golden.check(self.checkout)


class RestoreTest(FreezeTestCase):
    def setUp(self):
        super().setUp()
        self.manifest = self.frozen()
        self.data = self.checkout.frozen_image(self.manifest).read_bytes()
        self.fake = test_recover.FakeBootloader()
        patcher = mock.patch("recover.Link", return_value=test_recover.link_to(self.fake))
        self.opened = patcher.start()
        self.addCleanup(patcher.stop)
        patcher = mock.patch("recover.REPLY_TIMEOUT", 0.05)
        patcher.start()
        self.addCleanup(patcher.stop)

    def restore(self, image=None):
        with contextlib.redirect_stdout(io.StringIO()):
            golden.restore(self.checkout, image, "port", None, False)

    def test_the_frozen_image_goes_through_whole_and_the_board_restarts(self):
        self.restore()
        self.assertEqual(bytes(self.fake.image), self.data)
        group, command, _ = self.fake.requests[-1]
        self.assertEqual((group, command), (0, 5))

    def test_it_says_that_the_secondary_slot_is_left_alone(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            golden.restore(self.checkout, None, "port", None, False)
        self.assertIn("secondary slot", out.getvalue())

    def test_a_flipped_copy_is_refused_and_no_port_is_even_opened(self):
        for where in ("body", "signature"):
            with self.subTest(where), tempfile.TemporaryDirectory() as folder:
                bad = Path(folder) / "flipped.bin"
                bad.write_bytes(golden_bench.flipped(self.data, golden.flip_offsets(self.data)[where]))
                with self.assertRaises(golden.GoldenError):
                    self.restore(bad)
        self.opened.assert_not_called()
        self.assertEqual(self.fake.requests, [])

    def test_a_board_in_the_middle_of_a_swap_is_given_the_time(self):
        with mock.patch("recover.enter") as enter:
            self.restore()
        self.assertEqual(enter.call_args.args[3], test_recover.recover.ENTER_THROUGH_A_SWAP)

    def test_main_reports_a_refusal_as_an_error(self):
        self.checkout.frozen_image(self.manifest).unlink()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = golden.main(["restore"], self.checkout)
        self.assertEqual(code, 1)
        self.assertIn("is missing", err.getvalue())

    def test_main_prints_the_offsets(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(golden.main(["offsets"], self.checkout), 0)
        offsets = golden.flip_offsets(self.data)
        self.assertEqual(out.getvalue(), f"body {offsets['body']}\nsignature {offsets['signature']}\n")


class StoreBinaryTest(unittest.TestCase):
    """tools/store_binary.py, which every build of the checkout runs."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)

    def git(self, *arguments: str) -> None:
        subprocess.run(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-C",
                        str(self.folder), *arguments], check=True, capture_output=True)

    def test_settings_from_the_command_line_are_found_in_the_cache(self):
        (self.folder / "CMakeCache.txt").write_text(
            "// a comment\nWEST_PYTHON:UNINITIALIZED=/some/python\n"
            "SB_CONF_FILE:STRING=/a/sysbuild.conf\n"
            "app_CONFIG_APP_WATCHDOG_TIMEOUT_SECONDS:UNINITIALIZED=30\n"
            "mcuboot_EXTRA_CONF_FILE:STRING=;/a/tfm.conf\n"
            "EXTRA_CONF_FILE:UNINITIALIZED=more.conf\n")
        self.assertEqual(store_binary.command_line_settings(self.folder),
                         ["app_CONFIG_APP_WATCHDOG_TIMEOUT_SECONDS=30", "EXTRA_CONF_FILE=more.conf"])

    def test_a_build_with_none_has_an_empty_list(self):
        (self.folder / "CMakeCache.txt").write_text("WEST_PYTHON:UNINITIALIZED=/some/python\n")
        self.assertEqual(store_binary.command_line_settings(self.folder), [])
        self.assertEqual(store_binary.command_line_settings(self.folder / "not there"), [])

    def test_the_commit_says_whether_firmware_had_changes(self):
        (self.folder / "firmware").mkdir()
        tracked = self.folder / "firmware" / "a.c"
        tracked.write_text("int a;\n")
        self.git("init", "-q")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "first")
        commit = store_binary.git_commit(self.folder)
        self.assertRegex(commit, r"^[0-9a-f]+$")

        tracked.write_text("int b;\n")
        self.assertEqual(store_binary.git_commit(self.folder), f"{commit}+uncommitted")
        tracked.write_text("int a;\n")
        self.assertEqual(store_binary.git_commit(self.folder), commit)

        new = self.folder / "firmware" / "new.c"
        new.write_text("int c;\n")
        self.assertEqual(store_binary.git_commit(self.folder), f"{commit}+uncommitted")
        new.unlink()

        # Only firmware/ goes into an image. freeze looks at the whole tree for itself.
        (self.folder / "notes.txt").write_text("notes\n")
        self.assertEqual(store_binary.git_commit(self.folder), commit)

    def test_a_folder_that_is_not_a_repository_says_unknown(self):
        self.assertEqual(store_binary.git_commit(self.folder), "unknown")

    def test_what_freeze_needs_goes_into_latest_json(self):
        build = self.folder / "build"
        image = build / "app" / "zephyr" / "zephyr.signed.bin"
        image.parent.mkdir(parents=True)
        image.write_bytes(make_image())
        (build / "CMakeCache.txt").write_text("app_CONFIG_X:UNINITIALIZED=1\n")
        repo = self.folder / "repo"
        repo.mkdir()
        (repo / ".git").mkdir()
        with mock.patch.object(sys, "argv", ["store_binary", "--build", str(build), "--repo", str(repo)]), \
                contextlib.redirect_stdout(io.StringIO()):
            store_binary.main()
        latest = json.loads((repo / "binaries" / "latest.json").read_text())
        self.assertEqual(latest["command_line"], ["app_CONFIG_X=1"])


class SettingsTest(unittest.TestCase):
    """What is committed, as it is now."""

    def test_the_committed_bootloader_has_it_turned_off(self):
        text = (FIRMWARE / "sysbuild/mcuboot/prj.conf").read_text()
        self.assertIn("CONFIG_CRANIUM_GOLDEN=n\n", text)
        self.assertEqual(golden.read_pin(text), (False, None, None))
        # And the tool has its place to write.
        golden.set_pin(text, "ab" * 32, 1234)

    def test_the_module_is_wired_into_the_bootloader_only(self):
        self.assertIn('mcuboot_EXTRA_ZEPHYR_MODULES "${CMAKE_CURRENT_LIST_DIR}/sysbuild/mcuboot/golden"',
                      (FIRMWARE / "sysbuild.cmake").read_text())
        self.assertTrue((FIRMWARE / "sysbuild/mcuboot/golden/zephyr/module.yml").exists())

    def test_the_check_on_the_image_number_is_on_whatever_the_golden_image_is(self):
        text = (FIRMWARE / "sysbuild/mcuboot/prj.conf").read_text()
        self.assertIn("CONFIG_BOOT_FLASH_AREA_HOOKS=y\n", text)
        cmake = (FIRMWARE / "sysbuild/mcuboot/golden/CMakeLists.txt").read_text()
        self.assertRegex(cmake, r"(?m)^zephyr_library_sources\(src/image_number_guard\.c\)$")
        self.assertRegex(cmake, r"(?m)^zephyr_library_sources_ifdef\(CONFIG_CRANIUM_GOLDEN src/golden\.c src/golden_policy\.c\)$")

    def test_the_readme_warns_before_it_teaches_the_gesture(self):
        readme = (REPO / "firmware/README.md").read_text()
        section = readme[readme.index("### The gesture"):]
        warning = section.index("On any other board this\ncan wipe it")
        self.assertLess(warning, section.index("1. Press and hold RESET."))
        self.assertIn("do not do the gesture on this board", readme[readme.index("### Going back to the old bootloader"):])

    def test_the_readme_flashes_the_bootloader_the_way_the_bench_does(self):
        readme = (REPO / "firmware/README.md").read_text()
        freezing = readme[readme.index("### Freezing an image"):readme.index("### Restoring a board")]
        options = "chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ"
        self.assertIn(options, freezing)
        self.assertIn(options, Path(golden_bench.__file__).read_text())
        self.assertNotIn("west flash", freezing)

    def test_the_partition_is_where_the_tool_thinks_and_only_the_bootloader_has_it(self):
        mcuboot = (FIRMWARE / "sysbuild/mcuboot/boards/nrf7002dk_nrf5340_cpuapp.overlay").read_text()
        match = re.search(r"golden_partition: partition@700000 \{\s*label = \"golden\";\s*"
                          r"reg = <0x700000 (0x[0-9a-f]+)>;", mcuboot)
        self.assertIsNotNone(match)
        self.assertEqual(int(match.group(1), 16), golden.PARTITION_SIZE)
        slot = re.search(r"slot1_partition: partition@0 \{\s*label = \"image-1\";\s*reg = <0x0 (0x[0-9a-f]+)>;", mcuboot)
        self.assertEqual(int(slot.group(1), 16), golden.PARTITION_SIZE)
        application = (FIRMWARE / "boards/nrf7002dk_nrf5340_cpuapp_ns.overlay").read_text()
        self.assertNotIn("golden_partition", application)
        self.assertIn("0x700000", application)

    def test_the_fault_address_is_the_partition(self):
        source = (FIRMWARE / "src/main.c").read_text()
        self.assertIn("#define GOLDEN_FLASH_ADDRESS 0x700000", source)

    def test_the_new_faults_are_kept_out_of_binaries(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / ".config"
            for fault in ("WRECK_SLOTS", "GOLDEN_FLIP"):
                config.write_text(f"CONFIG_APP_TEST_FAULT_{fault}=y\n")
                self.assertTrue(store_binary.has_test_fault(config), fault)

    def test_the_bench_only_builds_through_scratch_copies(self):
        source = Path(golden_bench.__file__).read_text()
        self.assertIn("build_image.sh", source)
        self.assertNotIn('"west"', source)

    def test_nothing_private_in_what_gets_committed(self):
        # The public repository holds the pin and the manifest, not the image or anything local.
        for path in (REPO / "tools/golden.py", GOLDEN_C, Path(golden_bench.__file__)):
            text = path.read_text()
            self.assertNotIn(".cranium", text, path)
            self.assertNotRegex(text, r"/Users/", path)


def tiny_elf(symbols: dict[str, int]) -> bytes:
    """A 32-bit ELF with nothing in it but a symbol table."""
    names = b"\0"
    entries = b"\0" * 16
    for name, value in symbols.items():
        entries += struct.pack("<IIIBBH", len(names), value, 4, 0x12, 0, 1)
        names += name.encode() + b"\0"
    header_size = 52
    strings_at = header_size
    symbols_at = strings_at + len(names)
    sections_at = symbols_at + len(entries)
    section = "<10I"
    sections = (struct.pack(section, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
                + struct.pack(section, 0, 3, 0, 0, strings_at, len(names), 0, 0, 1, 0)
                + struct.pack(section, 0, 2, 0, 0, symbols_at, len(entries), 1, 1, 4, 16))
    header = (b"\x7fELF\x01\x01\x01" + b"\0" * 9
              + struct.pack("<HHIIIIIHHHHHH", 2, 40, 1, 0, 0, sections_at, 0, header_size, 0, 0, 40, 3, 0))
    return header + names + entries + sections


class ElfTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "zephyr.elf"

    def test_a_function_is_found_without_its_thumb_bit(self):
        self.path.write_bytes(tiny_elf({"other": 0x101, golden_bench.GESTURE_SYMBOL: 0x5921}))
        self.assertEqual(golden_bench.elf_symbol(self.path, golden_bench.GESTURE_SYMBOL), 0x5920)

    def test_a_bootloader_without_the_gesture_is_said_to_be_one(self):
        self.path.write_bytes(tiny_elf({"main": 0x101}))
        with self.assertRaisesRegex(BenchFailed, "golden image built in"):
            golden_bench.elf_symbol(self.path, golden_bench.GESTURE_SYMBOL)

    def test_something_else_is_not_read(self):
        self.path.write_bytes(b"not an elf")
        with self.assertRaisesRegex(BenchFailed, "not a 32-bit ELF"):
            golden_bench.elf_symbol(self.path, golden_bench.GESTURE_SYMBOL)

    def test_the_symbol_name_is_one_the_bootloader_defines(self):
        self.assertIn(f"__noinline enum golden_gesture_result {golden_bench.GESTURE_SYMBOL}(void)",
                      GOLDEN_C.read_text())

    def test_it_is_reached_after_the_pin_is_configured_and_before_it_is_read(self):
        """The debug port drives the pin at this function's entry, so any reading before it would
        see a button that is up, on the bench and off it. With a real hand such a reading sees it
        down. A bench run could not tell the two apart, so this is checked here: the one reading of
        the button anywhere is inside this function."""
        source = GOLDEN_C.read_text()
        configured = source.index("gpio_pin_configure_dt(&button, GPIO_INPUT)")
        called = source.index(f"switch ({golden_bench.GESTURE_SYMBOL}())")
        self.assertLess(configured, called)
        start = source.index(f"{golden_bench.GESTURE_SYMBOL}(void)")
        end = source.index("static bool gesture_fired(void)")
        readings = [match.start() for match in re.finditer(r"gpio_(?:pin|port)_get\w*\(|nrf_gpio_pin_read\(", source)]
        self.assertEqual(len(readings), 1, "another reading of a pin: does it come before the bench drives it?")
        self.assertTrue(start < readings[0] < end)
        self.assertLess(end, configured)


class RestoreOrderTest(unittest.TestCase):
    """What golden_policy.c decides is tested on the host. Whether golden.c does it shows on a board,
    in G11 and in the listing after a restore. This keeps that from drifting in between."""

    def setUp(self):
        source = GOLDEN_C.read_text()
        self.restore = source[source.index("static FUNC_NORETURN void restore("):source.index("static FUNC_NORETURN void seal(")]

    def test_the_primary_slot_goes_by_the_policy_and_then_the_secondary_and_only_then_the_copy(self):
        order = [self.restore.index(text) for text in
                 ("golden_erase_steps(", "boot_erase_region(primary, steps[i].off, steps[i].size, false)",
                  "boot_erase_region(secondary, 0, flash_area_get_size(secondary), false)", "boot_copy_region(")]
        self.assertEqual(order, sorted(order))
        self.assertEqual(self.restore.count("boot_erase_region("), 2)

    def test_the_erase_stops_at_the_first_error(self):
        self.assertIn("i < GOLDEN_ERASE_STEPS && rc == 0", self.restore)
        self.assertIn("if (rc != 0 ||", self.restore)


class IntelHexTest(unittest.TestCase):
    def test_what_is_written_reads_back_without_the_erased_flash(self):
        data = bytes(range(1, 200)) + b"\x00\xff\x01" + b"\xff" * 1000
        text = golden_bench.intel_hex_text(data)
        self.assertTrue(text.endswith(":00000001FF\n"))
        self.assertEqual(bytes(golden_bench.intel_hex_bytes(text, 0x10000)[a] for a in range(202)), data[:202])
        self.assertEqual(len(golden_bench.intel_hex_bytes(text, 0x10000)), 202)

    def test_every_line_has_a_good_checksum(self):
        for line in golden_bench.intel_hex_text(bytes(range(1, 40))).splitlines():
            self.assertEqual(sum(bytes.fromhex(line[1:])) & 0xff, 0)

    def test_it_reads_bytes_by_address_and_stops_where_it_is_told(self):
        text = ":0400000001020304F2\n:020000040001F9\n:0200000005060000\n:00000001FF\n"
        self.assertEqual(golden_bench.intel_hex_bytes(text, 0x10000), {0: 1, 1: 2, 2: 3, 3: 4})
        self.assertEqual(golden_bench.intel_hex_bytes(text, 0x20000)[0x10001], 6)


@unittest.skipUnless(ZEPHYR_BASE, "needs the SDK's headers, through ZEPHYR_BASE")
class TheBoardIsWhatTheBenchThinksTest(unittest.TestCase):
    def setUp(self):
        self.sdk = Path(ZEPHYR_BASE).parent

    def test_the_registers_are_those_in_the_nordic_header(self):
        header = (self.sdk / "modules/hal/nordic/nrfx/bsp/stable/mdk/nrf5340_application.h").read_text()
        base = re.search(r"#define NRF_P1_S_BASE\s+(0x[0-9A-Fa-f]+)UL", header)
        self.assertEqual(int(base.group(1), 16), golden_bench.P1_SECURE_BASE)
        gpio = header[header.index("P0_NS Structure"):]
        gpio = gpio[:gpio.index("} NRF_GPIO_Type")]
        for name, offset in (("OUTCLR", golden_bench.GPIO_OUTCLR), ("IN", golden_bench.GPIO_IN),
                             ("DIRSET", golden_bench.GPIO_DIRSET), ("DIRCLR", golden_bench.GPIO_DIRCLR)):
            with self.subTest(name):
                found = re.search(rf"\b{name};\s+/\*!< \(@ (0x[0-9A-Fa-f]+)\)", gpio)
                self.assertEqual(int(found.group(1), 16), offset)

    def test_button_2_is_that_pin_and_active_low_on_this_board(self):
        board = (self.sdk / "zephyr/boards/nordic/nrf7002dk/nrf5340_cpuapp_common.dtsi").read_text()
        self.assertRegex(board, rf"button1: button_1 \{{\s*gpios = <&gpio1 {golden_bench.BUTTON_2_PIN} "
                                r"\(GPIO_PULL_UP \| GPIO_ACTIVE_LOW\)>")
        self.assertIn("sw1 = &button1;", board)

    def test_led_1_is_that_pin_and_active_high_on_this_board(self):
        board = (self.sdk / "zephyr/boards/nordic/nrf7002dk/nrf5340_cpuapp_common.dtsi").read_text()
        self.assertEqual(golden_bench.LED_1_MASK, 1 << 6)
        self.assertRegex(board, r"led0: led_0 \{\s*gpios = <&gpio1 6 GPIO_ACTIVE_HIGH>")

    def test_the_led_registers_are_those_in_the_nordic_header(self):
        header = (self.sdk / "modules/hal/nordic/nrfx/bsp/stable/mdk/nrf5340_application.h").read_text()
        gpio = header[header.index("P0_NS Structure"):]
        gpio = gpio[:gpio.index("} NRF_GPIO_Type")]
        for name, offset in (("OUT", golden_bench.GPIO_OUT), ("DIR", golden_bench.GPIO_DIR)):
            with self.subTest(name):
                self.assertEqual(int(re.search(rf"\b{name};\s+/\*!< \(@ (0x[0-9A-Fa-f]+)\)", gpio).group(1), 16), offset)

    def test_the_stub_of_the_hook_header_says_what_mcuboot_says(self):
        include = self.sdk / "bootloader/mcuboot/boot/bootutil/include/bootutil"
        stub = (REPO / "firmware/tests/host/stubs/bootutil/boot_hooks.h").read_text()
        self.assertIn(re.search(r"#define BOOT_HOOK_REGULAR \d+", (include / "bootutil_public.h").read_text()).group(0), stub)
        declaration = re.search(r"int flash_area_id_from_multi_image_slot_hook\([^)]*\);", (include / "boot_hooks.h").read_text())
        self.assertEqual(" ".join(declaration.group(0).split()),
                         " ".join(re.search(r"int flash_area_id_from_multi_image_slot_hook\([^)]*\);", stub).group(0).split()))

    def test_the_sdk_is_still_the_one_that_needs_the_guard(self):
        """If MCUboot gets a bounds check of its own, this says so, and the guard can go."""
        boot = self.sdk / "bootloader/mcuboot/boot"
        self.assertIn("return all_slots[img * 2 + slot];", (boot / "zephyr/include/sysflash/sysflash.h").read_text())
        source = (boot / "boot_serial/src/boot_serial.c").read_text()
        self.assertIn("img_num = img_num_tmp;", source)
        self.assertIn("flash_area_open(flash_area_id_from_multi_image_slot(img_num, 0), &fap)", source)
        self.assertIn("BOOT_HOOK_FLASH_AREA_CALL(flash_area_id_from_multi_image_slot_hook",
                      (boot / "zephyr/flash_map_extended.c").read_text())

    def test_the_trailer_magic_is_where_the_application_looks(self):
        public = (self.sdk / "bootloader/mcuboot/boot/bootutil/include/bootutil/bootutil_public.h").read_text()
        size = re.search(r"#define BOOT_MAGIC_SZ\s+(\d+)", public).group(1)
        self.assertIn(f"#define TRAILER_MAGIC_SIZE {size}\n", (FIRMWARE / "src/ota.c").read_text())

    def test_what_the_bench_waits_for_from_mcuboot_itself_is_in_its_source(self):
        boot = self.sdk / "bootloader/mcuboot/boot"
        loader = (boot / "bootutil/src/loader.c").read_text()
        main = (boot / "zephyr/main.c").read_text()
        self.assertIn('"Image in the %s slot is not valid!"', loader)
        for text in (golden_bench.BOOTS_AN_IMAGE, golden_bench.IN_SERIAL_RECOVERY, golden_bench.STARTED):
            self.assertIn(text, main)


class SaysTest(unittest.TestCase):
    def test_what_the_bench_waits_for_from_the_gesture_is_in_golden_c(self):
        strings = re.findall(r'BOOT_LOG_\w+\("([^"]+)"', GOLDEN_C.read_text())
        for name, pattern in golden_bench.SAYS.items():
            with self.subTest(name):
                self.assertTrue(any(re.search(pattern, text) for text in strings),
                                f"{pattern!r} is in none of {strings}")

    def test_every_line_of_golden_c_says_golden(self):
        for text in re.findall(r'BOOT_LOG_\w+\("([^"]+)"', GOLDEN_C.read_text()):
            self.assertRegex(text, golden_bench.ANY_GOLDEN_LINE)


class ACommander:
    """A stand-in for J-Link Commander, as a program that takes the same input on a terminal."""

    PROGRAM = textwrap.dedent('''\
        #!{python}
        import json, os, re, sys, time
        log = open(os.environ["FAKE_LOG"], "a", buffering=1)
        log.write(json.dumps({{"args": sys.argv[1:]}}) + "\\n")
        start = open(sys.argv[sys.argv.index("-CommandFile") + 1]).read()
        log.write(json.dumps({{"start": start}}) + "\\n")
        def say(text):
            sys.stdout.write(text + "\\n")
            sys.stdout.flush()
        say("Processing script file...")
        say("J-Link>exec DisableAutoUpdateFW")
        say("Script processing completed.")
        say("Connecting to J-Link via USB...O.K.")
        if os.environ.get("FAKE_NO_TARGET"):
            say("Cannot connect to target.")
            say("J-Link>")
            time.sleep(60)
        say("Cortex-M33 identified.")
        in_register = 0xffffffff
        direction = 0
        out = 0xffffffff
        halted = False
        bp_set = False
        for line in sys.stdin:
            line = line.strip()
            log.write(json.dumps({{"at": time.time(), "command": line}}) + "\\n")
            word = line.split(" ")[0].lower()
            if word == "r":
                halted = True
            elif word == "ishalted":
                say("CPU is halted (PC = 0x00000100)." if halted else "CPU is not halted.")
            elif word == "setbp":
                bp_set = True
                say("Breakpoint set @ addr 0x%s (Handle = 7)" % line.split(" ")[1])
            elif word == "clrbp":
                bp_set = False
                say("Breakpoint cleared")
            elif word == "g":
                halted = False
            elif word == "waithalt":
                if bp_set and not os.environ.get("FAKE_NO_BREAK"):
                    halted = True
                    say("CPU halted.")
                else:
                    say("CPU not halted. Timeout of 10000 ms exceeded")
            elif word == "w4":
                match = re.fullmatch(r"w4 ([0-9A-F]{{8}}), ([0-9A-F]{{8}})", line)
                address, value = int(match.group(1), 16), int(match.group(2), 16)
                if address == 0x5084280C:
                    out &= ~value
                elif address == 0x50842818:
                    direction |= value
                elif address == 0x5084281C:
                    direction &= ~value
            elif word == "mem32":
                address = line.split(" ")[1].rstrip(",")
                stuck = os.environ.get("FAKE_PIN_STUCK_HIGH")
                level = 0xffffffff if stuck or not (direction & 0x200) else (0xffffffff & ~0x200)
                say("%s = %08X" % (address, level))
            elif word == "savebin":
                path = line.split(" ")[1].rstrip(",")
                open(path, "wb").write(bytes(0x10000))
                say("Reading 65536 bytes from addr 0x00000000 into file...O.K.")
            elif word == "exit":
                break
        ''')

    def __init__(self, folder: Path):
        self.path = folder / "JLinkExe"
        self.log = folder / "jlink.log"
        self.path.write_text(self.PROGRAM.format(python=sys.executable))
        self.path.chmod(self.path.stat().st_mode | stat.S_IXUSR)
        self.environment = mock.patch.dict(os.environ, {"FAKE_LOG": str(self.log)})
        self.environment.start()

    def commands(self) -> list[str]:
        lines = [json.loads(line) for line in self.log.read_text().splitlines()]
        return [line["command"] for line in lines if "command" in line]

    def arguments(self) -> list[str]:
        return json.loads(self.log.read_text().splitlines()[0])["args"]

    def start_file(self) -> str:
        return json.loads(self.log.read_text().splitlines()[1])["start"]

    def times(self) -> dict[str, float]:
        lines = [json.loads(line) for line in self.log.read_text().splitlines()]
        return {line["command"]: line["at"] for line in lines if "command" in line}


class JLinkButtonTest(unittest.TestCase):
    OUTCLR = f"w4 5084280C, {golden_bench.BUTTON_2_MASK:08X}"
    DIRSET = f"w4 50842818, {golden_bench.BUTTON_2_MASK:08X}"
    DIRCLR = f"w4 5084281C, {golden_bench.BUTTON_2_MASK:08X}"

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        self.commander = ACommander(self.folder)
        self.addCleanup(self.commander.environment.stop)
        elf = self.folder / "zephyr.elf"
        elf.write_bytes(tiny_elf({golden_bench.GESTURE_SYMBOL: 0x5921}))
        self.button = golden_bench.JLinkButton(str(self.commander.path), "1050797470", elf)

    def hold(self, seconds=0.2):
        with contextlib.redirect_stdout(io.StringIO()):
            self.button.hold_through_reset(seconds)

    def test_the_session_is_with_this_probe_and_this_core(self):
        self.hold()
        arguments = self.commander.arguments()
        self.assertEqual(arguments[arguments.index("-USB") + 1], "1050797470")
        self.assertEqual(arguments[arguments.index("-Device") + 1], "nRF5340_xxAA_APP")
        self.assertEqual(arguments[arguments.index("-If") + 1], "SWD")

    def test_commander_may_not_replace_the_firmware_of_the_probe(self):
        self.hold()
        self.assertEqual(self.commander.start_file(), "exec DisableAutoUpdateFW\n")

    def test_the_order_of_a_press(self):
        self.hold()
        commands = self.commander.commands()
        expected = ["r", "IsHalted", "SetBP 00005920 T H", "g", "WaitHalt 10000", self.OUTCLR, self.DIRSET,
                    "mem32 50842810, 1", "ClrBP 7", "g", self.DIRCLR, "mem32 50842810, 1", "g", "exit"]
        self.assertEqual(commands, expected)

    def test_the_level_goes_low_before_the_pin_becomes_an_output(self):
        self.hold()
        commands = self.commander.commands()
        self.assertLess(commands.index(self.OUTCLR), commands.index(self.DIRSET))

    def test_it_holds_for_as_long_as_asked(self):
        self.hold(0.5)
        times = self.commander.times()
        self.assertGreaterEqual(times[self.DIRCLR] - times[self.DIRSET], 0.5)

    def test_the_bootloader_lets_go_of_a_stuck_button_so_the_port_stays_untouched(self):
        with mock.patch("time.sleep") as sleep:
            self.hold(golden_bench.HOLD_GIVES_UP + 1)
        self.assertNotIn(self.DIRCLR, self.commander.commands())
        # Waiting for the program to end sleeps as well, in small steps.
        sleep.assert_any_call(golden_bench.HOLD_GIVES_UP + 1)
        self.assertEqual(self.commander.commands()[-2:], ["g", "exit"])

    def test_no_breakpoint_reached_means_no_press_and_a_clean_end(self):
        with mock.patch.dict(os.environ, {"FAKE_NO_BREAK": "1"}), \
                mock.patch.object(golden_bench.JLink, "wait_for", autospec=True,
                                  side_effect=self.without_long_waits()), \
                self.assertRaisesRegex(BenchFailed, "CPU halted"):
            self.hold()
        commands = self.commander.commands()
        self.assertNotIn(self.DIRSET, commands)
        self.assertEqual(commands[-1], "exit")

    def without_long_waits(self):
        real = golden_bench.JLink.wait_for

        def wait_for(jlink, pattern, timeout=10):
            return real(jlink, pattern, min(timeout, 1))
        return wait_for

    def test_a_pin_that_will_not_go_low_is_a_failure_and_is_let_go_of(self):
        with mock.patch.dict(os.environ, {"FAKE_PIN_STUCK_HIGH": "1"}), \
                self.assertRaisesRegex(BenchFailed, "still reads high"):
            self.hold()
        commands = self.commander.commands()
        self.assertIn(self.DIRCLR, commands)
        self.assertEqual(commands[-2:], ["g", "exit"])

    def test_no_target_is_reported(self):
        with mock.patch.dict(os.environ, {"FAKE_NO_TARGET": "1"}), \
                mock.patch.object(golden_bench.JLink, "wait_for", autospec=True,
                                  side_effect=self.without_long_waits()), \
                self.assertRaisesRegex(BenchFailed, "identified"):
            self.hold()

    def test_reading_the_bootloader_back(self):
        jlink = golden_bench.JLink(str(self.commander.path), "1050797470")
        target = self.folder / "read.bin"
        try:
            jlink.save(target, 0, 0x10000)
        finally:
            jlink.close()
        self.assertEqual(target.stat().st_size, 0x10000)
        self.assertIn(f"savebin {target}, 0, 10000", self.commander.commands())


class PersonButtonTest(unittest.TestCase):
    def asked(self, seconds: float) -> str:
        said = []
        golden_bench.PersonButton(ask=said.append).hold_through_reset(seconds)
        return said[0]

    def test_the_gesture_in_full(self):
        text = self.asked(golden_bench.HOLD_TO_FIRE)
        for step in ("press and hold RESET", "Press and hold Button 2", "Let go of RESET", "LED1 blinks fast",
                     "within the next 5 s"):
            self.assertIn(step, text)

    def test_other_holds_say_for_how_long(self):
        self.assertIn("for 30 s", self.asked(golden_bench.HOLD_PAST_THE_WINDOW))
        self.assertIn("for 2 s", self.asked(golden_bench.HOLD_TOO_SHORT))


class HoldTimesTest(unittest.TestCase):
    def setUp(self):
        policy = (FIRMWARE / "sysbuild/mcuboot/golden/src/golden_policy.h").read_text()
        self.ms = {name: int(value) for name, value in re.findall(r"#define GOLDEN_(\w+)_MS\s+(\d+)", policy)}

    def test_each_hold_lands_where_it_is_meant_to(self):
        self.assertLess(golden_bench.HOLD_TOO_SHORT * 1000, self.ms["ARMED"])
        self.assertGreater(golden_bench.HOLD_TO_FIRE * 1000, self.ms["ARMED"])
        self.assertLess(golden_bench.HOLD_TO_FIRE * 1000, self.ms["CANCEL"])
        self.assertGreater(golden_bench.HOLD_PAST_THE_WINDOW * 1000, self.ms["CANCEL"])
        self.assertLess(golden_bench.HOLD_PAST_THE_WINDOW * 1000, self.ms["GIVE_UP"])
        self.assertEqual(golden_bench.HOLD_GIVES_UP * 1000, self.ms["GIVE_UP"])
        self.assertGreater(golden_bench.HOLD_INTO_THE_APPLICATION, golden_bench.HOLD_GIVES_UP)


class ScratchCheckoutTest(unittest.TestCase):
    def test_a_rehearsal_runs_the_same_checks_as_the_frozen_image(self):
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder) / "candidate.bin"
            image.write_bytes(make_image())
            checkout = golden_bench.scratch_checkout(Path(folder) / "scratch", image)
            manifest, data = golden.check(checkout)
            self.assertEqual(data, image.read_bytes())
            self.assertEqual(manifest["hash_tlv"], golden.parse_image(data).hash_tlv)

    def test_it_is_not_the_repository_and_leaves_it_alone(self):
        before = (FIRMWARE / "sysbuild/mcuboot/prj.conf").read_text()
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder) / "candidate.bin"
            image.write_bytes(make_image())
            golden_bench.scratch_checkout(Path(folder) / "scratch", image)
        self.assertEqual((FIRMWARE / "sysbuild/mcuboot/prj.conf").read_text(), before)


class PlanTest(unittest.TestCase):
    def test_every_test_of_the_design_is_there(self):
        expected = {"G0", "G1", "G2", "G3", "G4", "G5a", "G5b", "G5c", "G5d", "G5e", "G5f", "G6", "G7", "G8",
                    "G9", "G10", "G11", "G12", "G13", "G14"}
        self.assertEqual(set(golden_bench.TESTS), expected)

    def test_the_plan_prints_them_and_opens_nothing(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(golden_bench, "Bench") as bench:
            golden_bench.show_plan()
        bench.assert_not_called()
        for name in golden_bench.TESTS:
            self.assertIn(name, out.getvalue())

    def test_the_default_gesture_needs_nobody(self):
        source = Path(golden_bench.__file__).read_text()
        self.assertIn('"--gesture", choices=["jlink", "person"], default="jlink"', source)


class BenchFlowTest(unittest.TestCase):
    """What the bench makes of what a board says, with the board and the ports replaced."""

    def bench(self, gesture="jlink") -> golden_bench.Bench:
        bench = golden_bench.Bench.__new__(golden_bench.Bench)
        bench.args = mock.Mock(gesture=gesture, serial_number="001050797470")
        bench.boot_lines = []
        bench.console_lines = []
        bench.made_button = mock.Mock()
        bench.manifest = {"hash_tlv": "ab" * 32, "version": "1.4.1+0"}
        bench.pin = "ab" * 32
        bench.version = "1.4.1+0"
        bench.image = make_image()
        return bench

    def say(self, bench, *lines):
        bench.boot_lines.extend(lines)

    def test_a_refusal_with_a_write_in_it_fails(self):
        bench = self.bench()
        bench.made_button.hold_through_reset.side_effect = lambda seconds: self.say(
            bench, "I: golden: restoring the pinned image", "E: golden: refused, neither copy")
        with self.assertRaisesRegex(BenchFailed, "should not have said"):
            bench.gesture_refused()

    def test_a_refusal_with_no_write_passes(self):
        bench = self.bench()
        bench.made_button.hold_through_reset.side_effect = lambda seconds: self.say(
            bench, "I: golden: gesture completed", "E: golden: refused, neither copy is the pinned image")
        self.assertIn("refused", bench.gesture_refused())

    def test_the_gesture_is_held_inside_the_window(self):
        bench = self.bench()
        bench.made_button.hold_through_reset.side_effect = lambda seconds: self.say(bench, "golden: refused")
        bench.gesture_refused()
        bench.made_button.hold_through_reset.assert_called_once_with(golden_bench.HOLD_TO_FIRE)

    def test_a_board_booting_with_the_button_down_fails_with_the_debug_port(self):
        bench = self.bench()
        self.say(bench, "I: Jumping to the first image slot")
        with self.assertRaisesRegex(BenchFailed, "should not have said"):
            bench.not_booted_yet(0)

    def test_a_person_cannot_tell_that_in_time(self):
        bench = self.bench("person")
        self.say(bench, "I: Jumping to the first image slot")
        bench.not_booted_yet(0)

    def test_a_board_that_says_nothing_fails_in_time(self):
        bench = self.bench()
        started = time.time()
        with self.assertRaisesRegex(BenchFailed, "did not say"):
            bench.wait_said("golden: sealed", 0, 0.2)
        self.assertLess(time.time() - started, 5)

    def test_an_upload_marks_the_log_after_it_was_sent_not_before(self):
        bench = self.bench()
        self.say(bench, "E: Image in the primary slot is not valid!")
        bench.with_bootloader = lambda action: action(mock.Mock())

        def upload(link, data):
            # What the bootloader said about the image from before, on the way in.
            self.say(bench, "E: Image in the primary slot is not valid!")

        with mock.patch.object(golden_bench.recover, "upload", upload), contextlib.redirect_stdout(io.StringIO()):
            mark = bench.upload_and_mark(b"data")
        self.assertEqual(mark, 2)
        with self.assertRaisesRegex(BenchFailed, "did not say"):
            bench.wait_said(golden_bench.PRIMARY_NOT_VALID, mark, 0.1)

    def test_after_a_gesture_the_secondary_slot_has_to_be_empty(self):
        bench = self.bench()
        bench.expect_running = mock.Mock(return_value={"firmware": "1.4.1+0", "thing name": "cranium-0000"})
        bench.baseline = mock.Mock(return_value=None)
        bench.certs = mock.Mock(return_value={})
        pinned = {"slot": 0, "version": "1.4.1", "hash": bench.pin}
        bench.listing = mock.Mock(return_value=[pinned])
        self.assertEqual(bench.expect_golden_back()["listed"], [pinned])
        bench.listing = mock.Mock(return_value=[pinned, {"slot": 1, "version": "1.1.40", "hash": "ee" * 32}])
        with self.assertRaisesRegex(BenchFailed, "secondary slot"):
            bench.expect_golden_back()

    def test_after_a_gesture_the_listed_image_has_to_be_the_pin(self):
        bench = self.bench()
        bench.expect_running = mock.Mock(return_value={"firmware": "1.4.1+0", "thing name": "cranium-0000"})
        bench.baseline = mock.Mock(return_value=None)
        bench.certs = mock.Mock(return_value={})
        bench.listing = mock.Mock(return_value=[{"slot": 0, "version": "1.4.1", "hash": "ee" * 32}])
        with self.assertRaisesRegex(BenchFailed, "the pin is"):
            bench.expect_golden_back()

    def test_a_changed_device_is_not_the_same_board(self):
        bench = self.bench()
        pinned = [{"slot": 0, "version": "1.4.1", "hash": bench.pin}]
        bench.listing = mock.Mock(return_value=pinned)
        bench.expect_running = mock.Mock(return_value={"firmware": "1.4.1+0", "thing name": "cranium-0000"})
        bench.certs = mock.Mock(return_value={"root CA": "set"})
        bench.baseline = mock.Mock(return_value={"thing name": "cranium-1111", "certs": {"root CA": "set"}})
        with self.assertRaisesRegex(BenchFailed, "thing name"):
            bench.expect_golden_back()
        bench.baseline = mock.Mock(return_value={"thing name": "cranium-0000", "certs": {"root CA": "unset"}})
        with self.assertRaisesRegex(BenchFailed, "certificates"):
            bench.expect_golden_back()

    def test_a_person_says_what_led1_did(self):
        bench = self.bench("person")
        bench.press = mock.Mock()
        bench.made_button.ask = mock.Mock(return_value="y")
        self.assertEqual(bench.press_watching_led("x", 3), {"LED1": "seen by a person"})
        self.assertIn("3 time", bench.made_button.ask.call_args.args[0])
        bench.made_button.ask = mock.Mock(return_value="n")
        with self.assertRaisesRegex(BenchFailed, "did not see LED1"):
            bench.press_watching_led("x", 3)

    def test_g5c_reports_what_the_debug_port_cannot_show(self):
        bench = self.bench()
        bench.certs = mock.Mock(return_value={"root CA": "set"})
        bench.status_up = mock.Mock(return_value={"state": "OPERATING"})
        bench.made_button.hold_through_reset.side_effect = lambda seconds: self.say(
            bench, "W: golden: Button 2 is still down after 60 s, booting anyway",
            "I: Jumping to the first image slot")
        with mock.patch("time.sleep"):
            result = bench.g5c()
        self.assertIn("ui.c", result["limit"])
        self.assertEqual(result["ui.c"], golden_bench.NOT_RUN)

    def test_g5c_fails_on_a_board_that_got_wiped(self):
        bench = self.bench("person")
        bench.certs = mock.Mock(side_effect=[{"root CA": "set"}, {"root CA": "unset"}])
        bench.status_up = mock.Mock(return_value={"state": "FACTORY"})
        bench.made_button.hold_through_reset.side_effect = lambda seconds: self.say(
            bench, "W: golden: Button 2 is still down after 60 s, booting anyway",
            "I: Jumping to the first image slot")
        with mock.patch("time.sleep"), self.assertRaisesRegex(BenchFailed, "wiped"):
            bench.g5c()


class CheckLedTest(unittest.TestCase):
    """Changes as they were read from a board, without a test mode in the bootloader."""

    ARMED = [(0.0, "dark"), (5.0, "lit"), (5.1, "dark"), (5.2, "lit"), (5.3, "dark"), (5.4, "lit"), (5.5, "dark"),
             (5.6, "lit"), (5.7, "dark"), (5.8, "lit"), (5.9, "dark"), (6.0, "lit"), (6.1, "dark"), (6.2, "lit"),
             (6.3, "dark"), (6.4, "lit"), (6.5, "dark"), (6.6, "lit"), (6.7, "dark"), (6.8, "lit"), (6.9, "dark"),
             (7.0, "lit"), (7.1, "dark")]
    NOTHING = [(10.07, "lit"), (10.57, "dark"), (11.07, "not an output"), (13.13, "dark"), (13.26, "lit"), (13.38, "dark")]
    REFUSED = [(10.07, "lit"), (10.57, "dark"), (11.07, "lit"), (11.57, "dark"), (12.07, "lit"), (12.57, "dark"),
               (13.07, "not an output")]

    def test_nothing_to_do_is_one_slow_blink(self):
        self.assertEqual(golden_bench.check_led(self.ARMED + self.NOTHING, 7.0, golden_bench.BLINKS_NOTHING),
                         {"changes while armed": 20, "slow blinks": 1})

    def test_a_refusal_is_three(self):
        self.assertEqual(golden_bench.check_led(self.ARMED + self.REFUSED, 7.0, golden_bench.BLINKS_REFUSED)["slow blinks"], 3)

    def test_what_the_application_does_with_the_led_later_does_not_count(self):
        self.assertEqual(golden_bench.check_led(self.ARMED + self.NOTHING, 7.0, 1)["slow blinks"], 1)

    def test_the_wrong_number_of_slow_blinks_fails(self):
        with self.assertRaisesRegex(BenchFailed, "lit for"):
            golden_bench.check_led(self.ARMED + self.NOTHING, 7.0, golden_bench.BLINKS_REFUSED)
        with self.assertRaisesRegex(BenchFailed, "lit for"):
            golden_bench.check_led(self.ARMED + self.REFUSED, 7.0, golden_bench.BLINKS_NOTHING)

    def test_a_slow_blink_of_the_wrong_length_fails(self):
        with self.assertRaisesRegex(BenchFailed, "lit for"):
            golden_bench.check_led(self.ARMED + [(10.0, "lit"), (12.5, "dark"), (13.0, "not an output")], 7.0, 1)

    def test_on_before_5_s_fails(self):
        with self.assertRaisesRegex(BenchFailed, "before the gesture was armed"):
            golden_bench.check_led([(0.0, "dark"), (2.0, "lit")] + self.ARMED[1:] + self.NOTHING, 7.0, 1)

    def test_a_blink_rate_that_is_off_fails(self):
        slow = [(0.0, "dark"), (5.0, "lit"), (6.0, "dark"), (7.0, "lit"), (7.1, "dark")]
        with self.assertRaisesRegex(BenchFailed, "while armed"):
            golden_bench.check_led(slow + self.NOTHING, 7.0, 1)


class LedWatchTest(unittest.TestCase):
    def test_it_reads_the_latch_and_the_direction_all_through_a_press(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            commander = ACommander(folder)
            self.addCleanup(commander.environment.stop)
            elf = folder / "zephyr.elf"
            elf.write_bytes(tiny_elf({golden_bench.GESTURE_SYMBOL: 0x5921}))
            button = golden_bench.JLinkButton(str(commander.path), "1050797470", elf)
            watch = golden_bench.LedWatch(lambda: True)
            with mock.patch.object(golden_bench, "LED_AFTER_THE_LOG_SECONDS", 0.1), \
                    contextlib.redirect_stdout(io.StringIO()):
                button.hold_through_reset(0.2, watch)
            commands = commander.commands()
        self.assertIn("mem32 50842804, 1", commands)
        self.assertIn("mem32 50842814, 1", commands)
        # The fake's registers read all ones, so an output at 1.
        self.assertEqual(watch.changes[0][1], "lit")
        self.assertGreaterEqual(watch.released_at, 0.2)
        release = commands.index(JLinkButtonTest.DIRCLR)
        self.assertIn("mem32 50842804, 1", commands[release + 1:])
        self.assertEqual(commands[-2:], ["g", "exit"])


class ScriptedJLink:
    """J-Link Commander for hold_into_the_input_driver(), saying what each stop finds."""

    DRIVER_READ = 0x8a000
    ON_INPUT = 0x360dc
    POST = 0x36116
    FACTORY_RESET = 0x35000
    PRESSED_AT = 0x2000df30

    def __init__(self, stops: list):
        self.stops = list(stops)
        self.sent = []
        self.written = []
        self.text = ""
        self.consumed = 0
        self.handle = 0
        self.stopped_at = None
        self.words = {0x20000004: 2 << 16, 0x20000008: 0, self.PRESSED_AT + 8: 0, self.PRESSED_AT + 12: 0,
                      golden_bench.P1_SECURE_BASE + golden_bench.GPIO_IN: 0}
        self.closed = False

    def send(self, command: str) -> None:
        self.sent.append(command)
        word = command.split(" ")[0]
        if word == "IsHalted":
            self.text += "CPU is halted (PC = 0x00000100).\n"
        elif word == "SetBP":
            self.handle += 1
            self.text += f"Breakpoint set @ addr 0x{command.split(' ')[1]} (Handle = {self.handle})\n"
        elif word == "ClrBP":
            self.text += "Breakpoint cleared\n"
        elif word == "WaitHalt":
            self.stopped_at = self.stops.pop(0) if self.stops else None
            self.text += "CPU halted.\n" if self.stopped_at is not None else "Timeout of it\n"
        elif word == "regs":
            self.text += f"PC = {self.stopped_at:08X}, R0 = 20000000\nFPSCR= 00000000\n"

    def wait_for(self, pattern: str, timeout: float = 10) -> re.Match:
        match = re.compile(pattern).search(self.text, self.consumed)
        if match is None:
            raise BenchFailed(f"no {pattern!r} in {self.text[self.consumed:]!r}")
        self.consumed = match.end()
        return match

    def write_word(self, address: int, value: int) -> None:
        self.written.append((address, value))

    def read_word(self, address: int) -> int:
        return self.words.get(address, 0)

    def close(self) -> None:
        self.closed = True


class HoldIntoTheInputDriverTest(unittest.TestCase):
    LISTING = textwrap.dedent('''\
        000360dc <on_input>:
           360f6:\tb143      \tcbz\tr3, 3610a <on_input+0x2e>
           36112:\t430a      \torrs\tr2, r1
           36114:\td0f5      \tbeq.n\t36102 <on_input+0x26>
           36116:\te9cd 3301 \tstrd\tr3, r3, [sp, #4]
           3615c:\t2000df30 \t.word\t0x2000df30
        ''')
    # The driver's two readings, then the release at on_input().
    GOOD_STOPS = [0x1000, ScriptedJLink.DRIVER_READ, ScriptedJLink.DRIVER_READ, None, ScriptedJLink.ON_INPUT]

    def run_it(self, stops: list, words: dict | None = None) -> tuple[ScriptedJLink, dict | None]:
        jlink = ScriptedJLink(stops)
        jlink.words.update(words or {})
        symbols = {"gpio_nrfx_port_get_raw.lto_priv.0": ScriptedJLink.DRIVER_READ, "on_input": ScriptedJLink.ON_INPUT,
                   "gpio_keys_init": 0x1000, "factory_reset": ScriptedJLink.FACTORY_RESET}
        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(golden_bench, "JLink", return_value=jlink), \
                mock.patch.object(golden_bench, "elf_symbol", lambda elf, name: symbols[name]), \
                mock.patch.object(golden_bench.subprocess, "run", return_value=mock.Mock(stdout=self.LISTING)), \
                mock.patch("time.sleep"):
            elf = Path(folder) / "zephyr.elf"
            elf.write_bytes(b"elf")
            try:
                return jlink, golden_bench.hold_into_the_input_driver("JLinkExe", "1", elf)
            except BenchFailed as error:
                self.last_error = str(error)
                return jlink, None

    def assert_tripped(self, jlink: ScriptedJLink, result, needle: str) -> None:
        self.assertIsNone(result)
        self.assertIn(needle, self.last_error)
        # It lets go of the pin, and the CPU never runs on from where it stopped.
        self.assertIn((golden_bench.P1_SECURE_BASE + golden_bench.GPIO_DIRCLR, golden_bench.BUTTON_2_MASK), jlink.written)
        self.assertEqual(jlink.sent.count("r"), 2)
        reset = len(jlink.sent) - 1 - jlink.sent[::-1].index("r")
        looked = len(jlink.sent) - 1 - jlink.sent[::-1].index("regs")
        self.assertNotIn("g", jlink.sent[looked:reset])
        self.assertTrue(jlink.closed)

    def test_the_addresses_come_from_the_listing(self):
        self.assertEqual(golden_bench.on_input_addresses(self.LISTING), {"post": 0x36116, "pressed_at": 0x2000df30})

    def test_an_image_without_the_fix_is_said_to_be_one(self):
        old = self.LISTING.replace("orrs", "cmp ")
        with self.assertRaisesRegex(BenchFailed, "no check that a press was seen"):
            golden_bench.on_input_addresses(old)

    def test_a_release_that_is_ignored_passes(self):
        jlink, result = self.run_it(self.GOOD_STOPS)
        self.assertEqual(result["event code"], golden_bench.INPUT_KEY_1)
        self.assertEqual(result["event value"], 0)
        self.assertEqual(result["pressed_at[1]"], [0, 0])
        self.assertTrue(result["pin stayed low until the release"])
        # The pin is driven low, level first, and let go of.
        base = golden_bench.P1_SECURE_BASE
        self.assertEqual(jlink.written, [(base + golden_bench.GPIO_OUTCLR, golden_bench.BUTTON_2_MASK),
                                         (base + golden_bench.GPIO_DIRSET, golden_bench.BUTTON_2_MASK),
                                         (base + golden_bench.GPIO_DIRCLR, golden_bench.BUTTON_2_MASK)])
        self.assertEqual(jlink.sent[-1], "g")
        self.assertTrue(jlink.closed)

    def test_both_tripwires_are_set(self):
        jlink, _ = self.run_it(self.GOOD_STOPS)
        self.assertIn(f"SetBP {ScriptedJLink.FACTORY_RESET:08X} T H", jlink.sent)
        self.assertIn(f"SetBP {ScriptedJLink.POST:08X} T H", jlink.sent)

    def test_a_release_that_reaches_the_event_is_a_failure(self):
        jlink, result = self.run_it(self.GOOD_STOPS + [ScriptedJLink.POST])
        self.assert_tripped(jlink, result, "TRIPWIRE")

    def test_a_factory_reset_is_a_failure(self):
        jlink, result = self.run_it(self.GOOD_STOPS + [ScriptedJLink.FACTORY_RESET])
        self.assert_tripped(jlink, result, "TRIPWIRE")

    def test_a_press_that_was_seen_is_not_the_case_under_test(self):
        jlink, result = self.run_it(self.GOOD_STOPS, {ScriptedJLink.PRESSED_AT + 8: 1234})
        self.assert_tripped(jlink, result, "not the release with no press seen")

    def test_stopping_anywhere_else_is_a_failure(self):
        jlink, result = self.run_it(self.GOOD_STOPS[:-1] + [0x4444])
        self.assert_tripped(jlink, result, "TRIPWIRE")


class OtherImageNumbersTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch("recover.REPLY_TIMEOUT", 0.05)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_each_number_is_tried_and_has_to_be_refused(self):
        fake = test_recover.FakeBootloader()
        fake.fail_upload_with = 3
        refusals = golden_bench.upload_for_other_images(test_recover.link_to(fake))
        self.assertEqual(sorted(refusals), sorted(str(number) for number in golden_bench.OTHER_IMAGE_NUMBERS))
        sent = [body["image"] for _, _, body in fake.requests]
        self.assertEqual(tuple(sent), golden_bench.OTHER_IMAGE_NUMBERS)

    def test_a_bootloader_that_takes_one_fails(self):
        fake = test_recover.FakeBootloader()
        with self.assertRaisesRegex(BenchFailed, "took a chunk for image 1"):
            golden_bench.upload_for_other_images(test_recover.link_to(fake))

    def test_no_answer_is_not_a_refusal(self):
        fake = test_recover.FakeBootloader()
        fake.lose = {1}
        with self.assertRaises(test_recover.recover.NoAnswer):
            golden_bench.upload_for_other_images(test_recover.link_to(fake))

    def test_the_numbers_sent_are_ones_that_cannot_reach_what_must_not_be_written(self):
        # An unguarded build of the bootloader mapped these to the slots. See firmware/README.md.
        self.assertEqual(golden_bench.OTHER_IMAGE_NUMBERS, (1, 3))
        self.assertLess(len(golden_bench.OTHER_IMAGE_CHUNK), 4096)

    def test_the_symbol_is_the_one_mcuboot_calls_and_the_guard_defines(self):
        self.assertIn(f"int {golden_bench.GUARD_SYMBOL}(int image_index, int slot, int *area_id)", GUARD_C.read_text())


class RunRecordTest(unittest.TestCase):
    def test_a_line_says_what_produced_it(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            hex_file = folder / "mcuboot.hex"
            hex_file.write_text(":00000001FF\n")
            bench = mock.Mock(manifest={"commit": "rehearsal", "file_sha256": "ab" * 32}, version="1.4.1+0", out=folder)
            bench.args = mock.Mock(gesture="jlink", mcuboot_hex=hex_file)
            with mock.patch.dict(golden_bench.TESTS, {"X": (lambda b: {"fine": 1}, "", "x")}), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(golden_bench.run_test(bench, "X"), "PASS")
            record = json.loads((folder / "results.jsonl").read_text())
        self.assertIs(record["rehearsal"], True)
        self.assertEqual(record["image sha256"], "ab" * 32)
        self.assertEqual(record["mcuboot sha256"], hashlib.sha256(b":00000001FF\n").hexdigest())
        self.assertEqual(record["bench sha256"], hashlib.sha256(Path(golden_bench.__file__).read_bytes()).hexdigest())
        self.assertRegex(record["commit"], r"^[0-9a-f]+$|^unknown$")
        self.assertIsInstance(record["dirty"], bool)

    def test_a_frozen_image_is_not_a_rehearsal(self):
        bench = mock.Mock(manifest={"commit": "abc1234", "file_sha256": "ab" * 32})
        bench.args = mock.Mock(mcuboot_hex=Path("/nonexistent"))
        what = golden_bench.what_ran(bench)
        self.assertIs(what["rehearsal"], False)
        self.assertIsNone(what["mcuboot sha256"])

    def run_one(self, result) -> tuple[str, dict]:
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            bench = mock.Mock(manifest={"commit": "a", "file_sha256": "b"}, version="1", out=folder)
            bench.args = mock.Mock(gesture="jlink", mcuboot_hex=folder / "none")
            def run(_):
                if isinstance(result, Exception):
                    raise result
                return result
            with mock.patch.dict(golden_bench.TESTS, {"X": (run, "", "x")}), contextlib.redirect_stdout(io.StringIO()):
                outcome = golden_bench.run_test(bench, "X")
            return outcome, json.loads((folder / "results.jsonl").read_text())

    def test_a_part_not_run_is_partial_and_says_which(self):
        outcome, record = self.run_one({"resets": 10, "power cuts": golden_bench.NOT_RUN})
        self.assertEqual(outcome, "PARTIAL")
        self.assertEqual(record["outcome"], "PARTIAL")
        self.assertEqual(record["not run"], ["power cuts"])

    def test_everything_run_is_a_pass(self):
        outcome, record = self.run_one({"resets": 10, "power cuts": 10})
        self.assertEqual(outcome, "PASS")
        self.assertNotIn("not run", record)

    def test_a_failure_is_a_failure(self):
        outcome, record = self.run_one(BenchFailed("nope"))
        self.assertEqual(outcome, "FAIL")
        self.assertEqual(record["error"], "nope")


class ExitCodeTest(unittest.TestCase):
    def run_main(self, outcomes: dict, *flags) -> tuple[int, list]:
        ran = []

        def run_test(bench, name):
            ran.append(name)
            return outcomes[name]

        with mock.patch.object(golden_bench, "Bench"), mock.patch.object(golden_bench, "run_test", run_test), \
                mock.patch.object(sys, "argv", ["golden_bench", "run", *outcomes, *flags]), \
                contextlib.redirect_stdout(io.StringIO()):
            return golden_bench.main(), ran

    def test_only_all_passes_exit_with_0(self):
        self.assertEqual(self.run_main({"G5a": "PASS", "G5b": "PASS"})[0], 0)
        self.assertEqual(self.run_main({"G5a": "PASS", "G5d": "PARTIAL"})[0], 1)
        self.assertEqual(self.run_main({"G5a": "FAIL", "G5b": "PASS"})[0], 1)

    def test_a_partial_does_not_stop_the_run_and_a_failure_can(self):
        self.assertEqual(self.run_main({"G5d": "PARTIAL", "G5b": "PASS"}, "--stop-on-failure")[1], ["G5d", "G5b"])
        self.assertEqual(self.run_main({"G5a": "FAIL", "G5b": "PASS"}, "--stop-on-failure")[1], ["G5a"])


class SimulatedBench(golden_bench.Bench):
    """The whole bench on a stand-in for the board: what its bootloader does is made up from the
    design, so a run shows that each test goes through, and what makes it fail. Nothing here shows
    that a real board behaves like this. Every line it says comes from the bench's own lists, and
    SaysTest ties those to the source.

    Flash work takes time on a board, so it only ends when something waits for it to end. A reset
    before that leaves the area half written, which is to say invalid.
    """

    # What each image does when it starts, in the design's terms.
    RUNS = {"golden": "1.4.1+0", "forward": "1.5.0+0", "crash": None, "flip-body": "1.9.6+0",
            "flip-signature": "1.9.5+0"}

    def __init__(self, args, folder: Path):
        self.args = args
        self.out = folder
        self.image = make_image()
        image_file = folder / "candidate.bin"
        image_file.write_bytes(self.image)
        self.checkout = golden_bench.scratch_checkout(folder / "rehearsal", image_file)
        self.manifest, _ = golden.check(self.checkout)
        self.pin = self.manifest["hash_tlv"]
        self.version = self.manifest["version"]
        self.baseline_file = folder / "baseline.json"
        self.boot_lines = []
        self.console_lines = []
        self.made_button = None
        self.console_device = "port"
        self.console_port = mock.Mock()
        self.console = mock.Mock()
        self.console.run.side_effect = lambda command: [f"Firmware {self.RUNS[self.primary]}"]
        self.primary = "golden"
        self.gold = "erased"
        self.pending = None
        self.wrong_pin = False
        self.boot_is_due = False
        self.booted = 0
        self.break_the_bootloader = None
        self.takes_other_images = False
        self.listed_in_secondary = False
        self.valid_after_restore_begins = False
        self.boot_again_after_refusal = False
        self.led = {"changes while armed": 20, "slow blinks": 1}

    # The board.

    def boot(self) -> None:
        self.booted += 1
        self.boot_lines.append("I: Starting bootloader")
        if self.primary in ("wreck", "damaged", "erased", "other key", "flipped"):
            if self.primary != "erased":
                self.boot_lines.append("E: Image in the primary slot is not valid!")
            self.boot_lines.append("I: Enter the serial recovery mode")
            return
        self.boot_lines.append("I: Jumping to the first image slot")
        self.run_application()

    def run_application(self) -> None:
        if self.primary == "crash":
            self.console_lines.append("Test image: crashing on purpose")
        elif self.primary == "wreck-to-be":
            self.primary = "damaged"
            self.boot()
        elif self.primary.startswith("flip"):
            self.gold = "bad"
            self.console_lines.append("Test image: golden byte at 7340032 changed from 4a to 48")

    def finish_flash_work(self) -> None:
        if self.pending == "restore":
            self.boot_lines.append("I: golden: restored, restarting")
            self.primary = "golden"
        elif self.pending == "seal":
            self.boot_lines.append("I: golden: sealed, restarting")
            self.gold = "good"
        if self.pending:
            self.pending = None
            self.boot()

    def press(self, seconds: float) -> None:
        self.interrupt_flash_work()
        self.boot_when_due()
        self.boot_lines.append("I: Starting bootloader")
        if seconds >= golden_bench.HOLD_GIVES_UP:
            self.boot_lines.append("W: golden: Button 2 is still down after 60 s, booting anyway")
            self.boot_after_the_gesture()
            return
        if not 5 <= seconds < 10:
            self.boot_lines.append("I: golden: Button 2 let go too early or too late, nothing done")
            self.boot_after_the_gesture()
            return
        self.boot_lines.append("I: golden: gesture completed")
        primary_ok = self.primary == "golden" and not self.wrong_pin
        golden_ok = self.gold == "good" and not self.wrong_pin
        if self.break_the_bootloader:
            primary_ok, golden_ok = self.break_the_bootloader(primary_ok, golden_ok)
        if golden_ok and not primary_ok:
            self.boot_lines.append("I: golden: restoring the pinned image")
            self.pending = "restore"
        elif primary_ok and not golden_ok:
            self.boot_lines.append("I: golden: sealing the running image")
            self.pending = "seal"
        elif primary_ok:
            self.boot_lines.append("I: golden: nothing to do")
            self.boot_after_the_gesture()
        else:
            self.boot_lines.append("E: golden: refused, neither copy is the pinned image")
            self.boot_after_the_gesture()

    def boot_after_the_gesture(self) -> None:
        """A moment after the release, so not before press() has returned."""
        self.boot_is_due = True

    def boot_when_due(self) -> None:
        if not self.boot_is_due:
            return
        self.boot_is_due = False
        if self.primary in ("damaged", "erased", "other key", "flipped"):
            self.boot_lines.append("I: Enter the serial recovery mode")
        else:
            self.boot_lines.append("I: Jumping to the first image slot")
            self.run_application()

    def interrupt_flash_work(self) -> None:
        if self.pending == "restore":
            # The old order of the erase: the old image still boots, with its trailer gone.
            self.primary = self.primary if self.valid_after_restore_begins else "erased"
        elif self.pending == "seal":
            self.gold = "erased"
        self.pending = None

    def wait_said(self, pattern: str, since: int, timeout: float) -> str:
        self.boot_when_due()
        if self.pending and re.search(pattern, "golden: restored, restarting golden: sealed, restarting"):
            self.finish_flash_work()
        lines = self.said(pattern, since)
        if not lines:
            raise BenchFailed(f"the bootloader did not say {pattern!r}")
        return lines[0]

    def wait_console_said(self, text: str, since: int, timeout: float) -> str:
        self.boot_when_due()
        for line in self.console_lines[since:]:
            if text in line:
                return line
        raise BenchFailed(f"the application did not say {text!r}")

    def reset_pin(self) -> None:
        self.interrupt_flash_work()
        self.boot_is_due = False
        self.boot()

    def nrfutil(self, *arguments: str) -> None:
        self.boot_when_due()
        if arguments[0] == "write":
            self.primary = "damaged"
        elif arguments[0] == "program":
            self.wrong_pin = "wrong" in arguments[2]
            self.boot()

    def program_mcuboot(self, hex_file: Path) -> None:
        self.nrfutil("program", "--firmware", str(hex_file))

    def damage_primary_by_probe(self) -> None:
        self.nrfutil("write")
        self.boot()

    def status_up(self, timeout: float = 0) -> dict:
        self.boot_when_due()
        running = self.RUNS.get(self.primary)
        if running is None:
            raise BenchFailed("the application did not answer")
        return {"firmware": running, "thing name": "cranium-0000", "state": "OPERATING"}

    def certs(self) -> dict:
        return {"root CA": "set", "private key": "set", "certificate": "set"}

    def save_bootloader(self) -> Path:
        return self.checkout.frozen / "mcuboot-before-golden.hex"

    def close_ports(self) -> None:
        pass

    def open_ports_when_back(self) -> None:
        pass

    def press_watching_led(self, ends_with: str, slow_blinks: int) -> dict:
        self.press(golden_bench.HOLD_TO_FIRE)
        if self.led["slow blinks"] != slow_blinks and slow_blinks == golden_bench.BLINKS_NOTHING:
            raise BenchFailed("LED1 was lit for the wrong times")
        return {"changes while armed": self.led["changes while armed"], "slow blinks": slow_blinks}

    def lose_power(self) -> None:
        """USB pulled and plugged back in. The boot log has gone by before the ports are back."""
        self.interrupt_flash_work()
        self.boot_is_due = False
        said = len(self.boot_lines)
        self.boot()
        del self.boot_lines[said:]

    def with_bootloader(self, action, leave_running: bool = True, reset: bool = True):
        self.boot_when_due()
        result = None
        if action is golden_bench.recover.show:
            if self.primary in self.RUNS or self.primary == "crash":
                digest = self.pin if self.primary == "golden" else "ee" * 32
                result = [{"slot": 0, "version": self.RUNS.get(self.primary) or "1.9.9", "hash": digest}]
                if self.listed_in_secondary:
                    result.append({"slot": 1, "version": "1.1.40", "hash": "ee" * 32})
            else:
                result = []
        elif action is golden_bench.upload_for_other_images:
            if self.takes_other_images:
                self.primary = "damaged"
                raise BenchFailed("the bootloader took a chunk for image 1: {'rc': 0, 'off': 256}")
            result = {str(number): "the bootloader answered with error 3" for number in golden_bench.OTHER_IMAGE_NUMBERS}
        if leave_running:
            self.boot()
        return result

    def upload(self, data: bytes) -> None:
        self.interrupt_flash_work()
        self.boot_when_due()
        if data == self.image:
            self.primary = "golden"
        elif data in self.args.named:
            self.primary = self.args.named[data]
        elif data == b"other key":
            self.primary = "other key"
        else:
            self.primary = "flipped"
        if self.primary == "wreck":
            self.primary = "wreck-to-be"
            self.boot_lines.append("I: Starting bootloader")
            self.boot_lines.append("I: Jumping to the first image slot")
            self.run_application()
            return
        self.boot()

    def upload_and_mark(self, data: bytes) -> int:
        mark = self.mark()
        self.upload(data)
        return mark

    def restore_by_tool(self) -> None:
        self.upload(self.image)

    def signed_with_a_throwaway_key(self) -> bytes:
        return b"other key"


class SimulatedRunTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        images = self.folder / "images"
        images.mkdir()
        named = {}
        for name, label in (("crash", "crash"), ("wreck", "wreck"), ("flip-body", "flip-body"),
                            ("flip-signature", "flip-signature")):
            content = f"image {name}".encode()
            (images / f"{name}.bin").write_bytes(content)
            named[content] = label
        forward = self.folder / "forward.bin"
        forward.write_bytes(make_image(version=(1, 5, 0, 0)))
        named[forward.read_bytes()] = "forward"
        real = self.folder / "mcuboot.hex"
        real.write_text(":00000001FF\n")
        wrong = self.folder / "wrongpin.hex"
        wrong.write_text(":00000001FF\n")
        elf = self.folder / "mcuboot.elf"
        elf.write_bytes(tiny_elf({golden_bench.GESTURE_SYMBOL: 0x5921, golden_bench.GUARD_SYMBOL: 0xa565}))
        self.args = mock.Mock(gesture="jlink", power_cuts=False, images=images, forward_image=forward,
                              mcuboot_hex=real, mcuboot_elf=elf, wrongpin_hex=wrong, wrongpin_elf=elf,
                              named=named)
        self.bench = SimulatedBench(self.args, self.folder)
        self.bench.made_button = mock.Mock()
        self.bench.made_button.power_cut.side_effect = self.bench.lose_power
        for patcher in (mock.patch("time.sleep"),
                        mock.patch.object(golden_bench, "hold_into_the_input_driver",
                                          return_value={"event value": 0})):
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_tests(self, *names) -> list[dict]:
        with contextlib.redirect_stdout(io.StringIO()):
            for name in names:
                golden_bench.run_test(self.bench, name)
        lines = (self.folder / "results.jsonl").read_text().splitlines()
        return [json.loads(line) for line in lines]

    def assert_passes(self, *names) -> list[dict]:
        records = self.run_tests(*names)
        for record in records:
            self.assertEqual(record["outcome"], "PASS", record)
        return records

    # What cannot pass with nobody at the board and no cable pulled.
    NEEDS_MORE = {"G5c", "G5d", "G5e", "G11"}

    def test_every_test_on_a_board_that_does_what_the_design_says(self):
        names = [name for name in golden_bench.TESTS if name != "G1"]
        records = self.run_tests(*names)
        self.assertEqual([record["test"] for record in records], names)
        for record in records:
            self.assertEqual(record["outcome"], "PARTIAL" if record["test"] in self.NEEDS_MORE else "PASS", record)

    def test_the_tests_that_use_the_reset_pin_say_that_no_power_was_cut(self):
        records = self.run_tests("G4", "G5d", "G11")
        self.assertEqual(records[0]["outcome"], "PASS")
        for record in records[1:]:
            self.assertEqual(record["outcome"], "PARTIAL")
            self.assertEqual(record["result"]["power cuts"], "not run")
            self.assertEqual(record["not run"], ["power cuts"])

    def test_with_power_cuts_those_tests_go_through_and_count_them(self):
        self.args.power_cuts = True
        records = self.run_tests("G4", "G5d", "G11")
        self.assertEqual([record["outcome"] for record in records], ["PASS", "PASS", "PASS"], records)
        self.assertEqual(records[1]["result"]["power cuts"], 10)
        restore, seal = records[2]["result"]["restore"], records[2]["result"]["seal"]
        self.assertEqual(restore[-len(golden_bench.POWER_CUT_AT):], ["serial recovery"] * len(golden_bench.POWER_CUT_AT))
        self.assertEqual(seal[-len(golden_bench.POWER_CUT_AT):], ["an image that passed"] * len(golden_bench.POWER_CUT_AT))
        self.assertGreaterEqual(self.bench.made_button.power_cut.call_count, 10 + 2 * len(golden_bench.POWER_CUT_AT))

    def test_a_power_cut_loses_the_boot_log_and_the_result_does_not_depend_on_it(self):
        self.assert_passes("G4")
        before = self.bench.mark()
        self.bench.cut_power()
        self.assertEqual(self.bench.mark(), before)
        self.assertEqual(self.bench.what_runs_after_a_cut(), "an image that passed")
        self.bench.primary = "damaged"
        self.assertEqual(self.bench.what_runs_after_a_cut(), "serial recovery")

    def test_a_cut_on_a_board_that_does_not_answer_either_way_fails(self):
        self.bench.primary = "damaged"
        with mock.patch.object(self.bench, "with_bootloader", side_effect=golden_bench.BoardError("not listening")), \
                self.assertRaises(golden_bench.BoardError):
            self.bench.what_runs_after_a_cut()

    def test_the_ports_are_let_go_of_before_the_cable_is_pulled(self):
        calls = mock.Mock()
        self.bench.close_ports = calls.close
        self.bench.open_ports_when_back = calls.open
        self.bench.made_button = calls.button
        self.bench.cut_power()
        self.assertEqual([call[0] for call in calls.mock_calls], ["close", "button.power_cut", "open"])

    def test_the_gesture_from_power_off_needs_a_person(self):
        record = self.run_tests("G5e")[-1]
        self.assertEqual(record["outcome"], "PARTIAL")
        self.assertEqual(record["not run"], ["gesture from power-off"])

    def test_the_gesture_from_power_off_with_a_person(self):
        self.assert_passes("G4")
        self.args.gesture = "person"

        def held_through_power_on():
            self.bench.primary = "golden"

        self.bench.made_button.hold_through_power_on.side_effect = held_through_power_on
        record = self.run_tests("G5e")[-1]
        self.assertEqual(record["outcome"], "PASS", record)
        self.bench.made_button.hold_through_power_on.assert_called_once()

    def test_g5f_runs_the_input_driver_and_checks_the_board_after_it(self):
        record = self.run_tests("G5f")[-1]
        self.assertEqual(record["outcome"], "PASS", record)
        with mock.patch.object(self.bench, "certs", side_effect=[{"root CA": "set"}, {"root CA": "unset"}]):
            self.fails("G5f", "wiped")

    def test_g5f_with_a_person_says_it_did_not_run(self):
        self.args.gesture = "person"
        record = self.run_tests("G5f")[-1]
        self.assertEqual(record["outcome"], "PARTIAL")

    def fails(self, name: str, needle: str) -> None:
        record = self.run_tests(name)[-1]
        self.assertEqual(record["outcome"], "FAIL", record)
        self.assertIn(needle, record["error"])

    def test_a_bootloader_that_seals_nothing_fails_g4(self):
        self.bench.break_the_bootloader = lambda primary_ok, golden_ok: (False, False)
        self.fails("G4", "sealing")

    def test_a_bootloader_that_ignores_the_pin_fails_g9(self):
        self.assert_passes("G4")
        self.bench.break_the_bootloader = lambda primary_ok, golden_ok: (primary_ok, True)
        self.fails("G9", "refused")

    def test_a_bootloader_that_trusts_a_damaged_copy_fails_g10(self):
        self.assert_passes("G4")
        self.bench.break_the_bootloader = lambda primary_ok, golden_ok: (primary_ok, True)
        self.fails("G10", "refused")

    def test_a_restore_that_runs_another_image_fails(self):
        self.assert_passes("G4")
        self.bench.upload(self.args.forward_image.read_bytes())
        self.bench.RUNS = {**SimulatedBench.RUNS, "golden": "9.9.9+0"}
        self.fails("G13", "expected")

    def test_a_bad_image_that_still_boots_fails_g12(self):
        self.assert_passes("G4")
        with mock.patch.object(self.bench, "upload", side_effect=lambda data: self.bench.boot()):
            self.fails("G12", "not valid")

    def test_a_bad_image_that_boots_at_the_second_look_fails_g12(self):
        self.assert_passes("G4")
        real_reset = self.bench.reset_pin

        def reset_into_it():
            real_reset()
            self.bench.boot_lines.append("I: Jumping to the first image slot")

        with mock.patch.object(self.bench, "reset_pin", reset_into_it):
            self.fails("G12", "should not have said")

    def test_a_restore_that_leaves_the_old_image_bootable_fails_g11(self):
        self.assert_passes("G4")
        self.bench.valid_after_restore_begins = True
        self.fails("G11", "still boots a second into a restore")

    def test_a_restore_that_leaves_the_secondary_slot_full_fails(self):
        self.assert_passes("G4")
        self.bench.listed_in_secondary = True
        self.fails("G8", "secondary slot")

    def test_another_image_in_the_listing_fails(self):
        self.assert_passes("G4")
        with mock.patch.object(self.bench, "RUNS", {**SimulatedBench.RUNS}):
            real = self.bench.with_bootloader

            def listed(action, leave_running=True, reset=True):
                result = real(action, leave_running, reset)
                if action is golden_bench.recover.show:
                    return [{**image, "hash": "ee" * 32} for image in result]
                return result

            with mock.patch.object(self.bench, "with_bootloader", listed):
                self.fails("G8", "the pin is")

    def test_a_wrecked_board_that_lists_something_fails_g7(self):
        self.assert_passes("G4")
        real = self.bench.with_bootloader

        def listed(action, leave_running=True, reset=True):
            result = real(action, leave_running, reset)
            return [{"slot": 0, "version": "1.9.7", "hash": "ee" * 32}] if action is golden_bench.recover.show else result

        with mock.patch.object(self.bench, "with_bootloader", listed):
            self.fails("G7", "still lists")

    def test_a_golden_line_on_a_normal_boot_fails_g3_and_g5d(self):
        real = self.bench.boot

        def boot_with_a_line():
            self.bench.boot_lines.append("I: golden: nothing to do")
            real()

        for name in ("G3", "G5d"):
            with self.subTest(name), mock.patch.object(self.bench, "boot", boot_with_a_line):
                self.fails(name, "should not have said")

    def test_a_board_that_boots_while_the_button_is_down_fails_g5a_and_g5b(self):
        real = self.bench.press

        def press_then_boot(seconds):
            real(seconds)
            self.bench.boot_lines.append("I: Jumping to the first image slot")

        for name in ("G5a", "G5b"):
            with self.subTest(name), mock.patch.object(self.bench, "press", press_then_boot):
                self.fails(name, "should not have said")

    def test_a_repeat_that_writes_again_fails_g4(self):
        self.assert_passes("G4")
        self.bench.gold = "bad"
        record = self.run_tests("G4")[-1]
        self.assertEqual(record["outcome"], "PASS", record)
        real = self.bench.press_watching_led

        def writes_on_the_repeat(ends_with, slow_blinks):
            self.bench.boot_lines.append("I: golden: sealing the running image")
            return real(ends_with, slow_blinks)

        self.bench.gold = "bad"
        with mock.patch.object(self.bench, "press_watching_led", writes_on_the_repeat):
            self.fails("G4", "should not have said")

    def test_a_led_that_does_the_wrong_thing_fails_g4(self):
        self.bench.led = {"changes while armed": 20, "slow blinks": 3}
        self.fails("G4", "lit for")

    def test_a_bootloader_that_takes_another_image_number_fails_g14(self):
        self.bench.takes_other_images = True
        self.fails("G14", "took a chunk for image 1")

    def test_g14_never_touches_a_bootloader_without_the_guard(self):
        self.args.mcuboot_elf.write_bytes(tiny_elf({golden_bench.GESTURE_SYMBOL: 0x5921}))
        with mock.patch.object(self.bench, "with_bootloader") as with_bootloader:
            self.fails("G14", golden_bench.GUARD_SYMBOL)
        with_bootloader.assert_not_called()

    def test_g14_sees_that_the_golden_copy_is_still_good(self):
        self.assert_passes("G4")
        record = self.run_tests("G14")[-1]
        self.assertEqual(record["outcome"], "PASS", record)
        self.assertEqual(sorted(record["result"]["refused"]), ["1", "3"])


if __name__ == "__main__":
    unittest.main()
