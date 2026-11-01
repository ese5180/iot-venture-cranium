#!/usr/bin/env python3
"""Tests of tools/board.py, tools/secrets.py and firmware/tests/hil/console_bench.py, without a
board.

    python3 firmware/tests/hil/test_board.py

Run from an nRF Connect SDK terminal, which provides pyserial and cbor2.

Part of this works against a stand-in that says what a board says. The rest works against
firmware/tests/host/build/console_sim, which is the console's real code on a pseudo-terminal:
`make -C firmware/tests/host` builds it. So the tools and the firmware's parser meet here.
Those tests are skipped if it has not been built.

The simulator's network, bootloader and cloud are made up, by the simulator and by the stand-in
for the programs the bench starts. So these tests show what the bench does with what a board
says: what a real board says is for the bench to find out.
"""

import base64
import contextlib
import importlib.util
import io
import json
import os
import pty
import re
import secrets  # noqa: F401  Before tools/ is on the path: tools/secrets.py would hide it.
import signal
import subprocess
import sys
import tempfile
import time
import tty
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import board  # noqa: E402
import console_bench  # noqa: E402
import provision_device  # noqa: E402
from board import BoardError, Console, ShellFirmware  # noqa: E402
from ota_bench import TestFailed as TestFailedError  # noqa: E402

SIMULATOR = REPO / "firmware/tests/host/build/console_sim"
PASSWORD = "correct-horse-battery"
STATUS_REPLY = (
    "state          OPERATING\r\n"
    "id             ABC123\r\n"
    "thing name     cranium-fe5b26c0c5b1dcd7\r\n"
    "firmware       1.3.0+0\r\n"
    "wifi network   Tester’s iPhone\r\n"
    "wifi password  set\r\n"
    "wifi link      up\r\n"
    "wifi address   02:00:00:00:00:01\r\n"
    "endpoint       example-ats.iot.us-east-1.amazonaws.com\r\n"
    "download from  https://b.s3.us-east-1.amazonaws.com/firmware/\r\n"
    "cloud          connected\r\n"
    "root CA        set\r\n"
    "private key    set\r\n"
    "certificate    set\r\n"
    "update         idle (last: none)\r\n"
    "OK\r\n"
)
OLD_STATUS_REPLY = (
    "prov status\r\n"
    "\x1b[1;32muart:~$ \x1b[mthing name     cranium-fe5b26c0c5b1dcd7\r\n"
    "firmware       1.2.0+0\r\n"
    "wifi network   stored, link up\r\n"
    "wifi address   02:00:00:00:00:01\r\n"
    "endpoint       example-ats.iot.us-east-1.amazonaws.com\r\n"
    "download from  https://b.s3.us-east-1.amazonaws.com/firmware/\r\n"
    "root CA        stored\r\n"
    "private key    stored\r\n"
    "certificate    stored\r\n"
    "[00:00:12.345,678] <inf> ota: a log line\r\n"
    "cloud          connected\r\n"
    "update         idle (last: none)\r\n"
    "\x1b[1;32muart:~$ \x1b[m"
)


class FakeBoard:
    """Takes the place of the serial port in board.Console."""

    def __init__(self, replies=None, shell=False):
        self.replies = replies or {}
        self.shell = shell
        self.written = []
        self.incoming = b""
        self.outgoing = b""
        self.noise = b""

    def write(self, data):
        self.written.append(data)
        self.incoming += data
        for ending in (b"\r",):
            while ending in self.incoming:
                line, self.incoming = self.incoming.split(ending, 1)
                self.answer(line.decode())

    def answer(self, line):
        if self.shell:
            if line == "prov status":
                self.outgoing += OLD_STATUS_REPLY.encode()
            elif line.startswith("prov button"):
                self.outgoing += (line + "\r\nOK button\r\n").encode()
            elif line:
                self.outgoing += f"{line}\r\n{line}: command not found\r\n".encode()
            return
        if not line:
            return
        if line == "ECHO|OFF":
            self.outgoing += self.noise + b"OK echo off\r\n"
            return
        reply = self.replies.get(line)
        if reply is None:
            reply = f"ERR unknown command {line.split('|')[0]}, type HELP\r\n"
        if reply != "":
            self.outgoing += reply.encode("utf-8")

    def read(self, size):
        data, self.outgoing = self.outgoing[:size], self.outgoing[size:]
        if not data:
            time.sleep(0.005)
        return data

    def close(self):
        pass


def console_on(fake):
    return Console("/dev/fake", fake)


class ParsingTest(unittest.TestCase):
    def test_crc_is_the_known_check_value(self):
        self.assertEqual(board.crc16_ccitt_false(b"123456789"), 0x29b1)
        self.assertEqual(board.crc16_ccitt_false(b""), 0xffff)

    def test_key_values(self):
        values = board.parse_key_values(["thing name     cranium-1", "wifi link      up",
                                         "-----BEGIN CERTIFICATE REQUEST-----", "nothing"])
        self.assertEqual(values, {"thing name": "cranium-1", "wifi link": "up"})

    def test_get_id(self):
        self.assertEqual(board.parse_get_id("OK ABC123|1.3.0+0"), ("ABC123", "1.3.0+0"))
        self.assertEqual(board.parse_get_id("OK |1.3.0+0"), ("", "1.3.0+0"))
        with self.assertRaises(BoardError):
            board.parse_get_id("ERR factory mode, send INIT|<id> first")

    def test_only_the_name_of_a_command_is_ever_shown(self):
        self.assertEqual(board.command_name(f"WIFI|net|{PASSWORD}"), "WIFI")
        self.assertEqual(board.command_name("GET_ID"), "GET_ID")

    def test_lines_that_belong_in_a_log(self):
        self.assertEqual(console_bench.strange_lines([
            "", "OK echo off", "ECHO|OFF", "ECHO|", "OFF", "ERR no such thing",
            "[BOOT] +------+", "[app] Cranium firmware 1.3.0+0", "[ota] WRN: careful",
            "[net_dhcpv4] bound", "[WIFI] connected ip=1.2.3.4 rssi=-51", "\x00[BOOT] | State",
        ]), [])
        for line in ("[ota]Image verified", "<inf> ota: Image verified", "Image verified",
                     "[00:00:12.345,678] <inf> ota: x", "ota] x"):
            self.assertEqual(console_bench.strange_lines([line]), [line])

    def test_a_log_line_in_a_reply_is_seen(self):
        first = "Cranium console, firmware 1.3.0+0"
        whole = [first, "Device:", "OK", "[ota] x", "[ota] y", first, "Device:", "OK", "[ota] z"]
        self.assertEqual(console_bench.log_lines_around_help(whole), ([], 2))
        self.assertEqual(console_bench.log_lines_around_help([first, "[ota] x", "OK"]),
                         (["[ota] x"], 0))
        self.assertEqual(console_bench.log_lines_around_help(["[ota] before", first, "OK"]), ([], 0))

    def test_erased_flash_as_intel_hex(self):
        text = console_bench.erased_flash_hex(0xf4000, 48 * 1024)
        address = upper = 0
        covered = []
        lines = text.splitlines()
        self.assertEqual(lines[-1], ":00000001FF")
        for line in lines:
            body = bytes.fromhex(line[1:])
            self.assertEqual(sum(body) & 0xff, 0, line)
            self.assertEqual(body[0], len(body) - 5)
            if body[3] == 4:
                upper = int.from_bytes(body[4:6], "big") << 16
            elif body[3] == 0:
                address = upper + int.from_bytes(body[1:3], "big")
                covered.append(address)
                self.assertEqual(body[4:-1], b"\xff" * body[0])
        self.assertEqual(covered[0], 0xf4000)
        self.assertEqual(address + 32, 0x100000)


class ConsoleTest(unittest.TestCase):
    def test_a_reply_is_its_lines_and_its_final_line(self):
        fake = FakeBoard({"NET": "state          connected\r\nip             1.2.3.4\r\nOK\r\n"})
        reply, final = console_on(fake).exchange("NET")
        self.assertEqual(reply, ["state          connected", "ip             1.2.3.4"])
        self.assertEqual(final, "OK")

    def test_tagged_lines_are_not_part_of_a_reply(self):
        fake = FakeBoard({"NET": "[net] Network is up\r\nstate          connected\r\n"
                                 "[WIFI] connected ip=1.2.3.4 rssi=-51\r\n[ota] ERR: x\r\nOK\r\n"})
        self.assertEqual(console_on(fake).run("NET"), ["state          connected"])

    def test_echo_is_turned_off_before_every_command(self):
        fake = FakeBoard({"GET_ID": "OK A|1\r\n"})
        console = console_on(fake)
        console.run("GET_ID")
        console.run("GET_ID")
        self.assertEqual(fake.written, [b"\rECHO|OFF\r", b"GET_ID\r"] * 2)

    def test_a_late_answer_to_an_earlier_handshake_is_not_this_commands_reply(self):
        # The board was busy, the tool gave up on one handshake and sent another. The answer
        # to the first ended the second, so the answer to the second comes next.
        fake = FakeBoard({"GET_ID": "OK echo off\r\nOK A|1\r\n"})
        self.assertEqual(console_on(fake).exchange("GET_ID")[1], "OK A|1")

    def test_a_late_reply_to_the_last_command_is_not_taken_for_this_one(self):
        fake = FakeBoard({"GET_ID": "OK A|1\r\n"})
        fake.noise = b"OK this is the reply to something earlier\r\n"
        self.assertEqual(console_on(fake).exchange("GET_ID")[1], "OK A|1")

    def test_an_error_names_the_command_and_the_reason_and_nothing_else(self):
        command = f"WIFI|net|{PASSWORD}"
        fake = FakeBoard({command: f"{PASSWORD} a line that should never be\r\n"
                                   "ERR the network could not be stored (-5)\r\n"})
        with self.assertRaises(BoardError) as caught:
            console_on(fake).run(command)
        self.assertEqual(str(caught.exception),
                         "`WIFI` failed: the network could not be stored (-5)")

    def test_no_reply_names_the_command_and_nothing_else(self):
        command = f"WIFI|net|{PASSWORD}"
        fake = FakeBoard({command: ""})
        with self.assertRaises(BoardError) as caught:
            console_on(fake).run(command, wait=0.05)
        self.assertNotIn(PASSWORD, str(caught.exception))
        self.assertIn("`WIFI`", str(caught.exception))

    def test_an_echo_that_came_back_on_is_not_a_reply_line(self):
        command = f"WIFI|net|{PASSWORD}"
        fake = FakeBoard({command: f"{command}\r\nOK saved, connecting to net\r\n"})
        self.assertEqual(console_on(fake).run(command), [])

    def test_a_network_name_goes_byte_for_byte(self):
        command = f"WIFI|Tester’s iPhone|{PASSWORD}"
        fake = FakeBoard({command: "OK saved\r\n"})
        console_on(fake).run(command)
        self.assertIn("Tester’s iPhone".encode("utf-8"), fake.written[-1])

    def test_a_board_that_does_not_answer(self):
        board.HANDSHAKE_SECONDS, seconds = 0.05, board.HANDSHAKE_SECONDS
        try:
            fake = FakeBoard()
            fake.answer = lambda line: None
            with self.assertRaisesRegex(BoardError, "does not answer"):
                console_on(fake).exchange("GET_ID")
        finally:
            board.HANDSHAKE_SECONDS = seconds

    def test_a_handshake_that_got_lost_is_tried_again(self):
        board.HANDSHAKE_SECONDS, seconds = 0.05, board.HANDSHAKE_SECONDS
        try:
            fake = FakeBoard({"GET_ID": "OK A|1\r\n"})
            answer = fake.answer
            lost = []

            def lose_the_first(line):
                if line == "ECHO|OFF" and not lost:
                    lost.append(line)
                    fake.outgoing += b"ERR line discarded, bytes of it were lost\r\n"
                else:
                    answer(line)

            fake.answer = lose_the_first
            self.assertEqual(console_on(fake).exchange("GET_ID")[1], "OK A|1")
        finally:
            board.HANDSHAKE_SECONDS = seconds

    def test_status(self):
        fake = FakeBoard({"STATUS": STATUS_REPLY})
        status = console_on(fake).status()
        self.assertEqual(status["state"], "OPERATING")
        self.assertEqual(status["thing name"], "cranium-fe5b26c0c5b1dcd7")
        self.assertEqual(status["firmware"], "1.3.0+0")
        self.assertEqual(status["wifi network"], "Tester’s iPhone")
        self.assertEqual(status["cloud"], "connected")
        self.assertEqual(status["update"], "idle (last: none)")
        self.assertEqual(status["private key"], "set")

    def test_status_in_factory_mode(self):
        fake = FakeBoard({"STATUS": "ERR factory mode, send INIT|<id> first\r\n",
                          "GET_ID": "OK |1.3.0+0\r\n",
                          "THING": "OK cranium-fe5b26c0c5b1dcd7\r\n"})
        status = console_on(fake).status()
        self.assertEqual(status, {"state": "FACTORY", "id": "", "firmware": "1.3.0+0",
                                  "thing name": "cranium-fe5b26c0c5b1dcd7"})

    def test_status_without_a_thing_name_is_refused(self):
        fake = FakeBoard({"STATUS": "ERR something else\r\n"})
        with self.assertRaisesRegex(BoardError, "STATUS"):
            console_on(fake).status()

    def test_the_bench_presses_a_button(self):
        fake = FakeBoard({"BUTTON|1": "OK button 1\r\n"})
        console_on(fake).press(1)
        self.assertIn(b"BUTTON|1\r", fake.written)

    def test_a_button_that_is_refused_is_an_error(self):
        fake = FakeBoard({"BUTTON|1": "ERR the application is busy\r\n"})
        with self.assertRaisesRegex(BoardError, "busy"):
            console_on(fake).press(1)


class OldFirmwareTest(unittest.TestCase):
    """An update from firmware with the shell to this firmware has to be followed through."""

    def test_status_of_firmware_with_the_shell(self):
        status = console_on(FakeBoard(shell=True)).status()
        self.assertEqual(status["thing name"], "cranium-fe5b26c0c5b1dcd7")
        self.assertEqual(status["firmware"], "1.2.0+0")
        self.assertEqual(status["cloud"], "connected")
        self.assertEqual(status["update"], "idle (last: none)")
        self.assertNotIn("state", status)

    def test_a_button_press_on_firmware_with_the_shell(self):
        fake = FakeBoard(shell=True)
        console_on(fake).press(1)
        self.assertIn(b"prov button 1\r", fake.written)

    def test_only_status_and_buttons_work_there(self):
        with self.assertRaises(ShellFirmware):
            console_on(FakeBoard(shell=True)).run("GET_ID")

    def test_a_board_is_asked_again_each_time(self):
        # In the middle of an update the firmware changes from one kind to the other.
        fake = FakeBoard(shell=True)
        console = console_on(fake)
        self.assertEqual(console.status()["firmware"], "1.2.0+0")
        fake.shell = False
        fake.replies["STATUS"] = STATUS_REPLY
        self.assertEqual(console.status()["firmware"], "1.3.0+0")


class ProvisioningTest(unittest.TestCase):
    def setUp(self):
        self.original_read = provision_device.read_wifi_secrets

    def tearDown(self):
        provision_device.read_wifi_secrets = self.original_read

    def test_the_network_is_sent_with_its_security(self):
        ssid = "Tester’s iPhone"
        provision_device.read_wifi_secrets = lambda: (ssid, PASSWORD, "WPA3_SAE")
        command = f"WIFI_SEC|{ssid}|WPA3_SAE|{PASSWORD}"
        fake = FakeBoard({command: f"OK saved, connecting to {ssid}\r\n"})
        provision_device.provision_wifi(console_on(fake))
        self.assertIn(command.encode("utf-8") + b"\r", fake.written)

    def test_a_certificate_goes_in_chunks_with_its_crc(self):
        der = bytes(range(256)) * 3
        expected = []

        class Recording(FakeBoard):
            def answer(self, line):
                if line == "ECHO|OFF" or not line:
                    super().answer(line)
                    return
                expected.append(line)
                self.outgoing += b"OK\r\n"

        provision_device.load_certificate(console_on(Recording()), der, "CERT")
        start = expected[0].split("|")
        self.assertEqual(start[0], "STREAM_START")
        self.assertEqual(int(start[1]), len(der))
        self.assertEqual(int(start[3], 16), board.crc16_ccitt_false(der))
        self.assertEqual(start[4], "CERT")
        chunks = expected[1:]
        self.assertEqual(int(start[2]), len(chunks))
        data = b""
        for index, chunk in enumerate(chunks):
            name, number, text = chunk.split("|")
            self.assertEqual((name, int(number)), ("STREAM_CHUNK", index))
            # Inside the console's line buffer.
            self.assertLess(len(chunk), 384)
            data += base64.b64decode(text)
        self.assertEqual(data, der)

    def test_a_board_in_factory_mode_gets_its_soc_id(self):
        fake = FakeBoard({"INIT|fe5b26c0c5b1dcd7": "OK initialised\r\n",
                          "GET_ID": "OK fe5b26c0c5b1dcd7|1.3.0+0\r\n", "STATUS": STATUS_REPLY})
        status = provision_device.first_time_setup(console_on(fake),
                                                   "cranium-fe5b26c0c5b1dcd7", None)
        self.assertEqual(status["state"], "OPERATING")

    def test_a_board_in_factory_mode_can_be_given_an_id(self):
        fake = FakeBoard({"INIT|MYBOARD": "OK initialised\r\n",
                          "GET_ID": "OK MYBOARD|1.3.0+0\r\n", "STATUS": STATUS_REPLY})
        provision_device.first_time_setup(console_on(fake), "cranium-1", "MYBOARD")
        self.assertIn(b"INIT|MYBOARD\r", fake.written)


@unittest.skipUnless(SIMULATOR.exists(), "run `make -C firmware/tests/host` first")
class SimulatedBoardTest(unittest.TestCase):
    """board.py against the real parser and the real command table."""

    def setUp(self):
        self.parent, self.child = pty.openpty()
        tty.setraw(self.child)
        self.process = subprocess.Popen([str(SIMULATOR)], stdin=self.child, stdout=self.child,
                                        stderr=subprocess.DEVNULL)
        os.close(self.child)
        self.link = PtyLink(self.parent)
        self.console = Console("/dev/simulated", self.link)
        self.console.wait_until_up(3)

    def tearDown(self):
        self.process.kill()
        self.process.wait()
        os.close(self.parent)

    def test_factory_mode_then_init_then_operating(self):
        status = self.console.status()
        self.assertEqual(status["state"], "FACTORY")
        self.assertEqual(status["id"], "")
        self.assertEqual(status["thing name"], "cranium-fe5b26c0c5b1dcd7")

        self.assertEqual(self.console.exchange("WIFI|a|b")[1],
                         "ERR factory mode, send INIT|<id> first")
        self.console.run("INIT|ABC123", wait=3)
        self.console.wait_until_up(3)
        status = self.console.status()
        self.assertEqual(status["state"], "OPERATING")
        self.assertEqual(self.console.get_id()[0], "ABC123")

    def test_a_listing_parses_with_all_its_keys(self):
        self.console.run("INIT|ABC123")
        self.console.wait_until_up(3)
        status = self.console.status()
        for key in console_bench.STATUS_KEYS:
            self.assertIn(key, status)
        self.assertEqual(status["wifi password"], "unset")
        self.assertEqual(status["cloud"], "not connected")

    def test_the_tools_load_a_certificate_through_the_real_stream_code(self):
        self.console.run("INIT|ABC123")
        self.console.wait_until_up(3)
        der = b"\x30\x82" + bytes(range(256)) * 4
        provision_device.load_certificate(self.console, der, "CERT")
        self.assertEqual(self.console.status()["certificate"], "set")

        provision_device.load_certificate(self.console, der, "CA")
        self.assertEqual(self.console.status()["root CA"], "set")

    def test_a_network_name_with_an_apostrophe_arrives_whole(self):
        self.console.run("INIT|ABC123")
        self.console.wait_until_up(3)
        ssid = "Tester’s iPhone"
        self.console.run(f"WIFI|{ssid}|{PASSWORD}")
        self.assertEqual(self.console.status()["wifi network"], ssid)
        self.assertEqual(self.console.status()["wifi password"], "set")

    def test_the_password_does_not_come_back_on_the_wire(self):
        self.console.run("INIT|ABC123")
        self.console.wait_until_up(3)
        self.link.keep = True
        self.console.run(f"WIFI|net|{PASSWORD}")
        for command in ("STATUS", "NET", "STATS", "HELP"):
            self.console.run(command)
        self.assertNotIn(PASSWORD.encode(), self.link.kept)
        self.assertIn(b"OK saved, connecting to net", self.link.kept)

    def test_a_bad_argument_is_an_error_that_shows_no_argument(self):
        self.console.run("INIT|ABC123")
        self.console.wait_until_up(3)
        with self.assertRaises(BoardError) as caught:
            self.console.run(f"WIFI|{'s' * 33}|{PASSWORD}")
        self.assertEqual(str(caught.exception), "`WIFI` failed: ssid must be 1-32 bytes")


class PtyLink:
    """The parent side of a pseudo-terminal, as the part of pyserial that Console uses."""

    def __init__(self, descriptor):
        self.descriptor = descriptor
        self.keep = False
        self.kept = b""
        os.set_blocking(descriptor, False)

    def read(self, size):
        try:
            data = os.read(self.descriptor, size)
        except BlockingIOError:
            time.sleep(0.005)
            return b""
        except OSError:
            return b""
        if self.keep:
            self.kept += data
        return data

    def write(self, data):
        os.write(self.descriptor, data)

    def close(self):
        pass


class SimulatedBoard:
    """console_sim on a pseudo-terminal, which is what the bench's serial port opens."""

    def start_simulator(self, environment=None):
        self.parent, self.child = pty.openpty()
        tty.setraw(self.child)
        self.process = subprocess.Popen([str(SIMULATOR)], stdin=self.child, stdout=self.child,
                                        stderr=subprocess.DEVNULL,
                                        env=dict(os.environ, **(environment or {})))
        self.addCleanup(self.stop_simulator)
        self.ports_opened = 0

        def open_port(device, baud, timeout):
            self.ports_opened += 1
            return PtyLink(self.parent)

        # The bench opens its port with pyserial; here the port is this pseudo-terminal.
        opener = mock.patch("ota_bench.serial.Serial", open_port)
        opener.start()
        self.addCleanup(opener.stop)

    def stop_simulator(self):
        self.process.kill()
        self.process.wait()
        os.close(self.child)
        os.close(self.parent)

    # ---- the programs the bench starts ---------------------------------------------------

    calls = None
    provision_works = True
    recover_fails = ()
    aws_signed_in = True
    uptimes = None

    def fake_run(self, command, **kwargs):
        self.calls.append([str(word) for word in command])
        text = " ".join(self.calls[-1])
        result = SimpleNamespace(returncode=0, stdout="", stderr="")
        if command[0] == "aws" and "get-thing-shadow" in text:
            uptime = self.uptimes.pop(0) if len(self.uptimes) > 1 else self.uptimes[0]
            Path(command[-1]).write_text(json.dumps({"state": {"reported": {"uptime": uptime}}}))
        elif command[0] == "aws":
            result.returncode = 0 if self.aws_signed_in else 255
        elif "provision_device.py" in text and self.provision_works:
            self.provision_board()
        elif "provision_device.py" in text:
            result.returncode = 1
        elif "recover.py" in text:
            self.fake_recover(self.calls[-1], result)
        elif command[0] == "nrfutil" and command[2] == "reset":
            os.write(self.parent, b"\rREBOOT\r")
        return result

    def fake_recover(self, words, result):
        action = next(word for word in words if word in ("list", "upload", "reset"))
        if action in self.recover_fails:
            result.returncode = 1
            result.stderr = f"error: {action} went wrong"
        elif action == "list":
            result.stdout = "slot 0: version 1.3.0\n"
        elif action == "reset":
            os.write(self.parent, b"\rREBOOT\r")
        else:
            self.process.send_signal(signal.SIGUSR1 if words[-1].endswith("fault.bin")
                                     else signal.SIGUSR2)
            time.sleep(0.1)

    def provision_board(self):
        """What tools/provision_device.py leaves behind."""
        console = Console("/dev/simulated", PtyLink(self.parent))
        console.wait_until_up(5)
        if console.status()["state"] == "FACTORY":
            console.run("INIT|fe5b26c0c5b1dcd7", wait=3)
            console.wait_until_up(5)
        console.run("KEYGEN|REPLACE", wait=5)
        der = b"\x30\x82" + bytes(range(256))
        provision_device.load_certificate(console, der, "CERT")
        provision_device.load_certificate(console, der, "CA")
        console.run("CLOUD|example-ats.iot.us-east-1.amazonaws.com|https://b.example.com/fw/")
        console.run(f"WIFI|net|{PASSWORD}")
        deadline = time.time() + 5
        while time.time() < deadline and console.status()["cloud"] != "connected":
            time.sleep(0.05)


@unittest.skipUnless(SIMULATOR.exists(), "run `make -C firmware/tests/host` first")
class BenchAgainstSimulatorTest(SimulatedBoard, unittest.TestCase):
    """The hardware script's checks, on the console's real code. What only real hardware
    can show, this cannot show; what the script looks for, and how it reads it, it can."""

    def setUp(self):
        self.start_simulator()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.calls = []
        for name in ("image.bin", "fault.bin"):
            (Path(self.folder.name) / name).write_bytes(b"\0" * 32)
        args = SimpleNamespace(
            out=self.folder.name, port="/dev/simulated", boot_port=None, join_timeout=3,
            image=str(Path(self.folder.name) / "image.bin"), profile="none",
            fault_image=str(Path(self.folder.name) / "fault.bin"),
            release_image=str(Path(self.folder.name) / "release.bin"),
            serial_number="123", no_erase=False)
        self.bench = console_bench.ConsoleBench(args)
        self.bench.credentials = ("Tester’s iPhone", PASSWORD, "WPA2_PSK")
        self.bench.secret_values.append(PASSWORD)
        self.bench.console.wait_until_up(5)

    def tearDown(self):
        self.bench.close_ports()

    def running_programs(self):
        """From here on, what the bench starts is played by fake_run()."""
        runner = mock.patch.object(console_bench.subprocess, "run", self.fake_run)
        runner.start()
        self.addCleanup(runner.stop)

    def provisioned(self):
        self.bench.close_ports()
        self.provision_board()
        self.bench.open_ports()

    def initialised(self):
        self.bench.check_3()

    def test_check_3_init(self):
        self.assertEqual(self.bench.check_3()["id"], "ABC123")

    def test_check_2_bad_init(self):
        self.initialised()
        self.assertEqual(self.bench.check_2()["state"], "OPERATING")

    def test_check_4_join(self):
        self.initialised()
        result = self.bench.check_4()
        self.assertEqual(result["ip"], "192.168.1.42")
        self.assertEqual(result["rssi"], -51)
        self.assertEqual(result["ip_after_reboot"], "192.168.1.42")

    def test_check_5_wrong_password(self):
        self.initialised()
        result = self.bench.check_5()
        self.assertEqual(result["reasons"], ["wrong password"])
        self.assertEqual(result["ip_with_right_password"], "192.168.1.42")
        status = self.bench.console.status()
        self.assertEqual(status["wifi link"], "up")

    def test_check_7_and_check_1(self):
        self.initialised()
        self.bench.check_7()
        with mock.patch.object(console_bench, "OFF_THE_NETWORK_SECONDS", 2):
            result = self.bench.check_1()
        self.assertIn("long flash", result["led1"])

    def test_settings(self):
        self.initialised()
        self.bench.settings()
        self.assertEqual(self.bench.console.get_id()[0], "NEWNAME1")

    def test_protocol(self):
        self.initialised()
        self.bench.protocol()

    def test_a_silent_board_is_given_time_and_the_network_goes_back(self):
        self.initialised()
        self.bench.join_right_network()
        real = self.bench.console.get_id
        silent = mock.Mock(side_effect=BoardError("does not answer: is it restarting?"))
        self.bench.console.get_id = silent

        self.bench.remember(console_bench.WRONG_NETWORK)
        with self.assertRaisesRegex(BoardError, "does not answer"):
            self.bench.check_5()
        self.bench.console.get_id = real

        self.assertTrue(silent.called)
        self.assertNotIn(console_bench.WRONG_NETWORK, self.bench.undone)
        self.assertEqual(self.bench.console.status()["wifi link"], "up")
        self.assertEqual(json.loads((Path(self.folder.name) / "undone.json").read_text()),
                         [console_bench.ERASED])

    def test_a_network_that_cannot_be_put_back_stays_on_record(self):
        self.initialised()
        real = self.bench.store_right_network
        self.bench.store_right_network = mock.Mock(side_effect=BoardError("no"))
        with self.assertRaisesRegex(TestFailedError, "could not be put back"):
            self.bench.check_5()
        self.assertIn(console_bench.WRONG_NETWORK, self.bench.undone)
        self.assertEqual(self.bench.store_right_network.call_count, console_bench.NETWORK_ATTEMPTS)

        # What main() does next.
        self.bench.store_right_network = real
        self.assertEqual(self.bench.network_back(), {"network": "put back"})
        self.assertNotIn(console_bench.WRONG_NETWORK, self.bench.undone)

    def test_settings_kept(self):
        self.initialised()
        self.bench.check_4()
        result = self.bench.settings_kept()
        self.assertEqual(result["id_kept"], "ABC123")
        status = self.bench.console.status()
        self.assertEqual(status["id"], "ABC123")
        self.assertEqual(status["wifi password"], "set")
        self.assertNotIn(console_bench.WRONG_NETWORK, self.bench.undone)

    def test_settings_kept_needs_a_board_on_the_network(self):
        self.initialised()
        with self.assertRaisesRegex(TestFailedError, "on the network"):
            self.bench.settings_kept()

    def test_settings_kept_notices_a_link_that_stays(self):
        self.initialised()
        self.bench.check_4()
        with mock.patch.object(console_bench, "WIFI_DISCONNECTED", re.compile("^never$")), \
                mock.patch.object(self.bench, "wait_line",
                                  side_effect=TestFailedError("no line like disconnected")):
            with self.assertRaisesRegex(TestFailedError, "disconnected"):
                self.bench.settings_kept()

    def test_log_lines(self):
        self.provisioned()
        with mock.patch.object(console_bench, "LOG_WATCH_SECONDS", 1.5):
            result = self.bench.log_lines()
        self.assertIn("app", result["modules"])
        self.assertIn("ota", result["modules"])
        self.assertGreater(result["log_lines_between_replies"], 0)

    def test_log_lines_needs_cloud_settings(self):
        self.initialised()
        with mock.patch.object(console_bench, "LOG_WATCH_SECONDS", 0.1), \
                self.assertRaisesRegex(TestFailedError, "cloud settings"):
            self.bench.log_lines()

    def test_log_lines_refuses_to_say_nothing(self):
        self.provisioned()
        with mock.patch.object(console_bench, "LOG_WATCH_SECONDS", 0.1), \
                mock.patch.object(console_bench, "log_lines_around_help", return_value=([], 0)), \
                self.assertRaisesRegex(TestFailedError, "shows nothing"):
            self.bench.log_lines()

    def test_log_lines_sees_a_line_inside_a_reply(self):
        self.provisioned()
        with mock.patch.object(console_bench, "LOG_WATCH_SECONDS", 0.1), \
                mock.patch.object(console_bench, "log_lines_around_help",
                                  return_value=(["[ota] x"], 1)), \
                self.assertRaisesRegex(TestFailedError, "inside a reply"):
            self.bench.log_lines()

    def test_log_lines_sees_a_line_without_its_tag(self):
        self.provisioned()
        with mock.patch.object(console_bench, "LOG_WATCH_SECONDS", 0.1), \
                mock.patch.object(console_bench, "strange_lines", return_value=["<inf> ota: x"]), \
                self.assertRaisesRegex(TestFailedError, "neither a reply nor tagged"):
            self.bench.log_lines()

    def test_the_bootloader_step(self):
        self.running_programs()
        self.initialised()
        self.assertEqual(self.bench.bootloader(), {"bootloader_says": "slot 0: version 1.3.0"})
        self.assertIn("--console", self.calls[-2])
        self.assertIn("reset", self.calls[-1])

    def test_the_bootloader_is_told_to_go_when_the_list_fails(self):
        self.running_programs()
        self.initialised()
        self.recover_fails = ("list",)
        with self.assertRaisesRegex(TestFailedError, "went wrong"):
            self.bench.bootloader()
        self.assertIn("reset", self.calls[-1])

    def test_a_reset_that_fails_does_not_hide_a_list_that_failed(self):
        self.running_programs()
        self.initialised()
        self.recover_fails = ("list", "reset")
        with self.assertRaisesRegex(TestFailedError, "list went wrong"):
            self.bench.bootloader()

    def test_check_6_with_a_test_image(self):
        self.running_programs()
        self.initialised()
        result = self.bench.check_6()
        self.assertEqual(result["id_left_behind"], "POWERCUT1")
        uploads = [call[-1] for call in self.calls if "upload" in call]
        self.assertEqual([Path(path).name for path in uploads], ["fault.bin", "image.bin"])
        self.assertNotIn(console_bench.FAULT_IMAGE, self.bench.undone)
        self.assertIn(console_bench.ERASED, self.bench.undone)

    def test_check_6_looks_for_both_images_before_it_touches_anything(self):
        self.running_programs()
        self.initialised()
        self.bench.forget(console_bench.ERASED)
        os.remove(self.bench.args.image)
        with self.assertRaisesRegex(TestFailedError, "image.bin does not exist"):
            self.bench.check_6()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.bench.undone, set())

    def test_a_fault_image_is_on_record_when_the_step_stops_half_way(self):
        self.running_programs()
        self.initialised()
        self.recover_fails = ()
        with mock.patch.object(self.bench, "wait_line", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.bench.check_6()
        self.assertEqual(sorted(console_bench.load_undone(Path(self.folder.name))),
                         sorted([console_bench.ERASED, console_bench.FAULT_IMAGE]))

    def test_check_1_on_erased_storage(self):
        self.running_programs()
        self.initialised()
        self.bench.check_7()
        with mock.patch.object(console_bench, "OFF_THE_NETWORK_SECONDS", 0.1):
            result = self.bench.check_1_erased_storage()
        self.assertIn("long flash", result["led1"])
        program, reset = self.calls[-2:]
        self.assertEqual(program[:3], ["nrfutil", "device", "program"])
        self.assertIn("chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE", program)
        self.assertEqual(program[-2:], ["--serial-number", "123"])
        self.assertEqual(reset[:3], ["nrfutil", "device", "reset"])
        hex_file = Path(program[program.index("--firmware") + 1])
        self.assertIn(":02000004000FEB", hex_file.read_text())

    def test_a_board_that_does_not_come_up_in_factory_mode_fails_check_1(self):
        self.running_programs()
        self.initialised()
        with self.assertRaisesRegex(TestFailedError, "OPERATING, expected FACTORY"):
            self.bench.check_1_erased_storage()

    def test_factory_mode_has_to_show_in_the_log(self):
        self.initialised()
        self.bench.check_7()
        with mock.patch.object(console_bench, "FACTORY_LOG_LINE", re.compile("^never$")), \
                self.assertRaisesRegex(TestFailedError, "no line like"):
            self.bench.factory_mode_holds(self.bench.mark())

    def test_release_image_needs_the_image(self):
        self.running_programs()
        step = console_bench.Step("release-image", "x", self.bench.release_image)
        self.assertTrue(self.bench.run_step(step))
        self.assertEqual(self.bench.results[-1]["outcome"], "SKIP")
        self.assertEqual(self.calls, [])

    def release_image_on_disk(self):
        Path(self.bench.args.release_image).write_bytes(b"\0" * 32)
        (Path(self.folder.name) / "outputs.json").write_text('{"Region": "us-east-1"}')
        outputs = mock.patch.object(console_bench, "OUTPUTS",
                                    Path(self.folder.name) / "outputs.json")
        outputs.start()
        self.addCleanup(outputs.stop)

    def test_release_image_has_to_report_to_the_cloud(self):
        self.running_programs()
        self.provisioned()
        self.release_image_on_disk()
        self.uptimes = [500, 500, 12]
        self.assertEqual(self.bench.release_image(), {"uptime_reported_by_release_image": 12})
        uploads = [call for call in self.calls if "upload" in call]
        self.assertIn("--console", uploads[0])
        self.assertEqual(Path(uploads[0][-1]).name, "release.bin")
        self.assertIn("--reset", uploads[1])
        self.assertEqual(Path(uploads[1][-1]).name, "image.bin")
        self.assertNotIn(console_bench.RELEASE_IMAGE, self.bench.undone)

    def test_a_release_image_that_stays_silent_fails_and_is_replaced(self):
        self.running_programs()
        self.provisioned()
        self.release_image_on_disk()
        self.uptimes = [500]
        self.bench.args.join_timeout = 0.1
        with self.assertRaisesRegex(TestFailedError, "may not have booted"):
            self.bench.release_image()
        self.assertEqual(Path([call for call in self.calls if "upload" in call][-1][-1]).name,
                         "image.bin")

    def test_no_log_holds_the_password(self):
        self.initialised()
        self.bench.check_4()
        self.bench.check_5()
        log = (Path(self.folder.name) / "vcom1-app.log").read_text(errors="replace")
        self.assertNotIn(PASSWORD, log)
        self.assertNotIn("wrong-", log)
        self.assertIn("[WIFI] connected", log)

    def test_the_migration_does_not_apply_to_a_board_with_the_console(self):
        step = console_bench.Step("migration", "x", self.bench.migration)
        self.assertTrue(self.bench.run_step(step))
        self.assertEqual(self.bench.results[-1]["outcome"], "SKIP")

    def test_results_are_recorded_like_those_of_the_other_bench(self):
        step = console_bench.Step("check-3-init", "x", self.bench.check_3)
        self.assertTrue(self.bench.run_step(step))
        step = console_bench.Step("broken", "x", lambda: self.bench.expect_final("GET_ID", "nope"))
        self.assertFalse(self.bench.run_step(step))
        records = [line for line in (Path(self.folder.name) / "results.jsonl").read_text().splitlines()]
        self.assertEqual(len(records), 2)
        self.assertIn('"outcome": "PASS"', records[0])
        self.assertIn('"scenario": "check-3-init"', records[0])
        self.assertIn('"outcome": "FAIL"', records[1])
        self.assertIn('"error"', records[1])

    def test_a_password_that_comes_back_fails_the_step(self):
        self.initialised()

        def with_echo_on():
            # What a person may do. A step must not get away with it.
            self.bench.link.write(b"ECHO|ON\r")
            time.sleep(0.2)
            self.bench.link.write(self.bench.wifi_command().encode() + b"\r")
            time.sleep(0.3)
            return {}

        step = console_bench.Step("leaky", "x", with_echo_on)
        self.assertFalse(self.bench.run_step(step))
        self.assertIn("held a password", self.bench.results[-1]["error"])

    def test_a_failure_shows_no_password(self):
        self.initialised()
        step = console_bench.Step("broken", "x",
                                  lambda: self.bench.expect_final(self.bench.wifi_command(),
                                                                  "nope " + PASSWORD))
        self.bench.run_step(step)
        text = (Path(self.folder.name) / "results.jsonl").read_text()
        self.assertNotIn(PASSWORD, text)


@unittest.skipUnless(SIMULATOR.exists(), "run `make -C firmware/tests/host` first")
class WrongPasswordEvidenceTest(SimulatedBoard, unittest.TestCase):
    """Check 5 must not pass without the password having been tried. A hotspot that has not
    been seen yet says other things first."""

    def bench_for(self, environment):
        self.start_simulator(environment)
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        args = SimpleNamespace(
            out=folder.name, port="/dev/simulated", boot_port=None, join_timeout=1,
            image="none", profile="none", fault_image="none", release_image="none",
            serial_number="123", no_erase=False)
        bench = console_bench.ConsoleBench(args)
        self.addCleanup(bench.close_ports)
        bench.credentials = ("net", PASSWORD, "WPA2_PSK")
        bench.secret_values.append(PASSWORD)
        bench.console.wait_until_up(5)
        bench.check_3()
        return bench

    def test_a_real_reason_after_others_passes(self):
        bench = self.bench_for({"SIM_WRONG_PASSWORD_REASONS": "network not found,no answer,timeout"})
        result = bench.check_5()
        self.assertEqual(result["reasons"], ["network not found", "no answer", "timeout"])
        self.assertEqual(bench.console.status()["wifi link"], "up")

    def test_only_network_not_found_is_a_failure_of_the_check(self):
        bench = self.bench_for({"SIM_WRONG_PASSWORD_REASONS": "network not found"})
        with self.assertRaisesRegex(TestFailedError, "never tried.*network not found"):
            bench.check_5()
        self.assertEqual(bench.console.status()["wifi link"], "up")
        self.assertNotIn(console_bench.WRONG_NETWORK, bench.undone)

    def test_only_a_refused_request_is_a_failure_of_the_check(self):
        bench = self.bench_for({"SIM_WRONG_PASSWORD_REASONS": "request refused,no answer"})
        with self.assertRaisesRegex(TestFailedError, "never tried"):
            bench.check_5()

    def test_no_failure_line_at_all(self):
        bench = self.bench_for({"SIM_WRONG_PASSWORD_REASONS": ""})
        with self.assertRaisesRegex(TestFailedError, r"never tried.*\[\]"):
            bench.check_5()

    def test_input_during_a_boot(self):
        bench = self.bench_for({"SIM_BOOT_TIME_MS": "1000"})
        self.assertGreater(bench.boot_input()["boot_seconds"], 0.5)

    def test_input_from_the_boot_that_gets_through_is_seen(self):
        bench = self.bench_for({"SIM_KEEPS_BOOT_INPUT": "1", "SIM_BOOT_TIME_MS": "1000"})
        with self.assertRaises(TestFailedError) as caught:
            bench.boot_input()
        self.assertRegex(str(caught.exception),
                         "echo is off|first command after a boot|input from during")


@unittest.skipUnless(SIMULATOR.exists(), "run `make -C firmware/tests/host` first")
class BenchMainTest(SimulatedBoard, unittest.TestCase):
    """main(), with the board on the simulator and the programs it starts played by stand-ins:
    what is left of the board when a step fails, a restore fails, or somebody presses Ctrl-C."""

    def setUp(self):
        self.start_simulator()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.out = Path(self.folder.name)
        self.calls = []
        self.outputs = self.out / "outputs.json"
        self.outputs.write_text('{"Region": "us-east-1"}')
        self.secrets_file = self.out / "wifi_secrets.h"
        self.secrets_file.write_text("readable")
        for name in ("image.bin", "fault.bin"):
            (self.out / name).write_bytes(b"\0" * 32)
        for patch in (mock.patch.object(console_bench.subprocess, "run", self.fake_run),
                      mock.patch.object(console_bench, "read_wifi_secrets",
                                        lambda: ("net", PASSWORD, "WPA2_PSK")),
                      mock.patch.object(console_bench, "OUTPUTS", self.outputs),
                      mock.patch.object(console_bench, "WIFI_SECRETS", self.secrets_file),
                      mock.patch.object(console_bench.shutil, "which", lambda name: "/bin/x"),
                      mock.patch.object(console_bench, "OFF_THE_NETWORK_SECONDS", 0.1)):
            patch.start()
            self.addCleanup(patch.stop)
        self.provision_board()
        self.ports_opened = 0

    def main(self, *arguments):
        """Returns its exit code and what it said."""
        said = io.StringIO()
        argv = ["console_bench.py", *arguments, "--port", "/dev/simulated", "--out", str(self.out),
                "--join-timeout", "3", "--image", str(self.out / "image.bin"),
                "--fault-image", str(self.out / "fault.bin"),
                "--release-image", str(self.out / "release.bin")]
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(said), \
                contextlib.redirect_stderr(said):
            try:
                code = console_bench.main()
            except SystemExit as stopped:
                code = stopped.code
        return code, said.getvalue()

    def results(self):
        path = self.out / "results.jsonl"
        lines = path.read_text().splitlines() if path.exists() else []
        return {json.loads(line)["scenario"]: json.loads(line)["outcome"] for line in lines}

    def undone(self):
        return console_bench.load_undone(self.out)

    def provisions(self):
        return [call for call in self.calls if "provision_device.py" in " ".join(call)]

    def test_a_step_that_fails_is_followed_by_one_restore(self):
        with mock.patch.object(console_bench.ConsoleBench, "settings",
                               side_effect=TestFailedError("broken")):
            code, said = self.main("run", "--erase", "--only", "check-7-factory-reset,settings")
        self.assertEqual(code, 1)
        self.assertEqual(self.results(), {"check-7-factory-reset": "PASS", "settings": "FAIL",
                                          "restore": "PASS"})
        self.assertEqual(len(self.provisions()), 1)
        self.assertEqual(self.undone(), set())
        self.assertNotIn("!!!", said)

    def test_a_restore_that_fails_runs_once_and_says_so(self):
        self.provision_works = False
        code, said = self.main("run", "--erase", "--only", "check-7-factory-reset,restore")
        self.assertEqual(code, 1)
        self.assertEqual(self.results()["restore"], "FAIL")
        self.assertEqual(len(self.provisions()), 1)
        self.assertEqual(self.undone(), {console_bench.ERASED})
        self.assertIn(f"!!! THE BOARD IS NOT AS IT WAS: {console_bench.ERASED}", said)
        self.assertIn("console_bench.py restore", said)

        # The same when --only leaves it out.
        (self.out / "undone.json").unlink()
        self.calls.clear()
        code, said = self.main("run", "--erase", "--only", "check-1-factory-mode")
        self.assertEqual(len(self.provisions()), 1)

    def test_nothing_runs_on_a_board_that_was_left_half_done(self):
        (self.out / "undone.json").write_text(json.dumps([console_bench.ERASED]))
        code, said = self.main("run", "--no-erase")
        self.assertEqual(code, 2)
        self.assertIn("left this undone", said)
        self.assertEqual(self.ports_opened, 0)

        code, said = self.main("plan")
        self.assertEqual(code, 0)
        self.assertIn("left this undone", said)
        self.assertEqual(self.ports_opened, 0)

        # And restore does put it right.
        code, said = self.main("restore")
        self.assertEqual(code, 0, said)
        self.assertEqual(self.undone(), set())

    def test_whatever_a_step_raises_is_a_failed_step(self):
        with mock.patch.object(console_bench.ConsoleBench, "check_2", side_effect=KeyError("state")):
            code, said = self.main("run", "--no-erase", "--only", "check-2-bad-init")
        self.assertEqual(code, 1)
        self.assertEqual(self.results()["check-2-bad-init"], "FAIL")
        self.assertIn("KeyError", said)

    def test_ctrl_c_restores_nothing_and_says_what_to_do(self):
        with mock.patch.object(console_bench.ConsoleBench, "check_3", side_effect=KeyboardInterrupt):
            code, said = self.main("run", "--erase", "--only",
                                   "check-7-factory-reset,check-3-init")
        self.assertEqual(code, 130)
        self.assertEqual(self.provisions(), [])
        self.assertEqual(self.undone(), {console_bench.ERASED})
        self.assertIn(f"!!! THE BOARD IS NOT AS IT WAS: {console_bench.ERASED}", said)
        self.assertIn("console_bench.py restore", said)

        code, said = self.main("restore")
        self.assertEqual(code, 0, said)
        self.assertEqual(len(self.provisions()), 1)
        self.assertEqual(self.undone(), set())

    def test_restore_takes_the_test_image_off_first(self):
        self.process.send_signal(signal.SIGUSR1)
        time.sleep(0.2)
        (self.out / "undone.json").write_text(json.dumps([console_bench.FAULT_IMAGE,
                                                          console_bench.ERASED]))
        code, said = self.main("restore")
        self.assertEqual(code, 0, said)
        words = [" ".join(call) for call in self.calls]
        upload = next(i for i, call in enumerate(words) if "upload" in call)
        provision = next(i for i, call in enumerate(words) if "provision_device.py" in call)
        self.assertLess(upload, provision)
        self.assertIn("--console", words[upload])
        self.assertTrue(words[upload].endswith("image.bin"))
        self.assertEqual(self.undone(), set())

    def test_restore_takes_a_release_image_off_through_the_debug_port(self):
        (self.out / "undone.json").write_text(json.dumps([console_bench.RELEASE_IMAGE]))
        code, said = self.main("restore")
        self.assertEqual(code, 0, said)
        upload = next(call for call in self.calls if "upload" in call)
        self.assertIn("--reset", upload)
        self.assertEqual(self.undone(), set())

    def test_restore_puts_the_right_network_back_first(self):
        (self.out / "undone.json").write_text(json.dumps([console_bench.WRONG_NETWORK]))
        with mock.patch.object(console_bench.ConsoleBench, "store_right_network",
                               autospec=True, side_effect=lambda bench: bench.forget(
                                   console_bench.WRONG_NETWORK)) as stored:
            code, said = self.main("restore")
        self.assertEqual(code, 0, said)
        self.assertEqual(stored.call_count, 1)
        self.assertEqual(self.undone(), set())

    def test_a_wrong_network_gets_one_more_try_at_the_end(self):
        real = console_bench.ConsoleBench.store_right_network
        attempts = []

        def fails_at_first(bench):
            attempts.append(1)
            if len(attempts) <= console_bench.NETWORK_ATTEMPTS:
                raise BoardError("no")
            real(bench)

        with mock.patch.object(console_bench.ConsoleBench, "store_right_network", fails_at_first):
            code, said = self.main("run", "--no-erase", "--only", "check-5-wrong-password")
        self.assertEqual(code, 1)
        self.assertEqual(self.results()["check-5-wrong-password"], "FAIL")
        self.assertEqual(self.results()["network-back"], "PASS")
        self.assertEqual(self.undone(), set())
        self.assertNotIn("!!!", said)

    def test_a_wrong_network_that_stays_is_said_out_loud(self):
        with mock.patch.object(console_bench.ConsoleBench, "store_right_network",
                               side_effect=BoardError("no")):
            code, said = self.main("run", "--no-erase", "--only", "check-5-wrong-password")
        self.assertEqual(code, 1)
        self.assertEqual(self.results()["network-back"], "FAIL")
        self.assertEqual(self.undone(), {console_bench.WRONG_NETWORK})
        self.assertIn(f"!!! THE BOARD IS NOT AS IT WAS: {console_bench.WRONG_NETWORK}", said)

    def test_a_run_that_keeps_the_settings_ends_with_the_board_online(self):
        code, said = self.main("run", "--no-erase", "--only", "check-2-bad-init")
        self.assertEqual(code, 0, said)
        self.assertEqual(self.results(), {"check-2-bad-init": "PASS", "back-online": "PASS"})

    def test_a_board_that_does_not_come_back_online_is_a_failure(self):
        console = Console("/dev/simulated", PtyLink(self.parent))
        console.run("CLEAR_WIFI")
        time.sleep(0.1)
        code, said = self.main("run", "--no-erase", "--only", "check-2-bad-init")
        self.assertEqual(code, 1)
        self.assertEqual(self.results()["back-online"], "FAIL")

    def test_a_failed_migration_ends_the_run(self):
        with mock.patch.object(console_bench.ConsoleBench, "migration",
                               side_effect=TestFailedError("the update failed")):
            code, said = self.main("run", "--no-erase", "--only", "migration,protocol")
        self.assertEqual(code, 1)
        self.assertEqual(self.results()["migration"], "FAIL")
        self.assertNotIn("protocol", self.results())

    def test_the_migration_when_it_applies(self):
        image = self.out / "image.bin"
        console = Console("/dev/simulated", PtyLink(self.parent))
        major, minor, patch = (int(part) for part in
                               console.get_id()[1].split("+")[0].split("."))
        build = int(console.get_id()[1].split("+")[1])
        image.write_bytes((0x96f3b83d).to_bytes(4, "little") + b"\0" * 16
                          + bytes([major, minor]) + patch.to_bytes(2, "little")
                          + build.to_bytes(4, "little") + b"\0" * 32)
        real_run = self.fake_run

        def update_runs(command, **kwargs):
            if "ota_bench.py" in " ".join(str(word) for word in command):
                folder = Path(command[command.index("--out") + 1])
                folder.mkdir(parents=True, exist_ok=True)
                (folder / "vcom1-app.log").write_text(self.update_log)
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            return real_run(command, **kwargs)

        once = iter([board.ShellFirmware("old firmware")])
        real_handshake = Console.handshake

        def shell_at_first(console_self):
            for error in once:
                raise error
            real_handshake(console_self)

        for self.update_log, expected in (("[CONSOLE] migrated: device id set to x\n", "PASS"),
                                          ("nothing of the kind\n", "FAIL")):
            once = iter([board.ShellFirmware("old firmware")])
            with mock.patch.object(console_bench.subprocess, "run", update_runs), \
                    mock.patch.object(Console, "handshake", shell_at_first):
                code, said = self.main("run", "--no-erase", "--only", "migration")
            self.assertEqual(self.results()["migration"], expected, said)

    def preflight_refuses(self, text):
        code, said = self.main("run", "--erase")
        self.assertEqual(code, 2, said)
        self.assertIn(text, said)
        self.assertEqual(self.ports_opened, 0)
        self.assertEqual(self.results(), {})

    def test_preflight_wants_the_secrets_readable(self):
        with mock.patch.object(console_bench.os, "access", lambda path, mode: False):
            self.preflight_refuses("--unlocked, which replaces a locked file")

    def test_preflight_wants_the_cloud_outputs(self):
        self.outputs.unlink()
        self.preflight_refuses("deploy the cloud stack")

    def test_preflight_wants_a_signed_in_profile(self):
        self.aws_signed_in = False
        self.preflight_refuses("is not signed in")

    def test_preflight_wants_both_images(self):
        (self.out / "image.bin").unlink()
        self.preflight_refuses("image.bin does not exist")

    def test_preflight_wants_the_debug_tool(self):
        with mock.patch.object(console_bench.shutil, "which", lambda name: None):
            self.preflight_refuses("nrfutil is missing")

    def test_keeping_the_settings_does_not_need_any_of_that(self):
        self.aws_signed_in = False
        self.outputs.unlink()
        code, said = self.main("run", "--no-erase", "--only", "check-2-bad-init")
        self.assertEqual(code, 0, said)


class SecretsFileTest(unittest.TestCase):
    """The hint the bench gives has to work on the file it is given for."""

    def load_tool(self, path):
        spec = importlib.util.spec_from_file_location("cranium_secrets", REPO / "tools/secrets.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.WIFI = path
        module.ensure_local_dir = lambda: path.parent
        module.known_spelling = lambda ssid: None
        return module

    def test_a_locked_file_is_replaced(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "wifi_secrets.h"
            path.write_text("the old one")
            # Root's file is as good as this one to somebody else: it cannot be opened to write.
            path.chmod(0o400)
            tool = self.load_tool(path)
            with mock.patch("builtins.input", side_effect=["net", ""]), \
                    mock.patch.object(tool.getpass, "getpass", return_value=PASSWORD), \
                    contextlib.redirect_stdout(io.StringIO()):
                tool.wifi(unlocked=True)
            self.assertIn(PASSWORD, path.read_text())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class PlanTest(unittest.TestCase):
    """The bench's plan touches nothing, and it says what erases."""

    def test_the_plan_opens_no_port_and_marks_what_erases(self):
        result = subprocess.run([sys.executable, str(Path(console_bench.__file__))],
                                capture_output=True, text=True, timeout=30,
                                env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("has not touched the board", result.stdout)
        for line in re.findall(r"^\s+\[(\w+)\s*\] (\S+)$", result.stdout, re.MULTILINE):
            self.assertEqual(line[0] == "ERASES",
                             line[1] in ("release-image", "check-7-factory-reset",
                                         "check-1-factory-mode", "check-1-erased-storage",
                                         "check-3-init", "settings", "check-6-power-loss",
                                         "restore"))
        for name, method, what, erases in console_bench.STEPS:
            self.assertTrue(hasattr(console_bench.ConsoleBench, method), method)
            self.assertIn(name, result.stdout)

    def test_running_needs_to_be_told_whether_it_may_erase(self):
        result = subprocess.run([sys.executable, str(Path(console_bench.__file__)), "run"],
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--erase or --no-erase", result.stderr)

    def test_all_seven_checks_are_in_the_plan(self):
        names = [row[0] for row in console_bench.STEPS]
        for number in range(1, 8):
            self.assertTrue(any(name.startswith(f"check-{number}-") for name in names), number)


if __name__ == "__main__":
    unittest.main()
