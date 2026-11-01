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
import threading
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
import fault_check  # noqa: E402
import ota_bench  # noqa: E402
import provision_device  # noqa: E402
from board import BoardError, Console, ShellFirmware  # noqa: E402
from ota_bench import ChipStuck, NotRun, WifiWatch  # noqa: E402
from ota_bench import TestFailed as TestFailedError  # noqa: E402

SIMULATOR = REPO / "firmware/tests/host/build/console_sim"
FAULT_SIMULATOR = REPO / "firmware/tests/host/build/console_sim_fault"
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

    def start_simulator(self, environment=None, simulator=SIMULATOR):
        self.parent, self.child = pty.openpty()
        tty.setraw(self.child)
        self.process = subprocess.Popen([str(simulator)], stdin=self.child, stdout=self.child,
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

    def short_limit(self):
        """The timer's limit, for a simulator that restarts SIM_CHIP_HANGS ms after a join starts."""
        for name, value in (("WIFI_SILENT_SECONDS", 3.0), ("BOUND_SLACK_SECONDS", 2.0)):
            patch = mock.patch.object(ota_bench, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def hanging_bench(self, environment=None):
        self.short_limit()
        bench = self.bench_for({"SIM_CHIP_HANGS": "2500"} | (environment or {}))
        bench.args.join_timeout = 30
        return bench

    def test_a_stuck_restart_and_then_the_wrong_password_passes(self):
        bench = self.hanging_bench()
        result = bench.check_5()
        self.assertEqual(result["reasons"], ["wrong password"])
        # It passes, and it does not pass quietly. This boot is too short to be sure of seeing it.
        self.assertEqual(result["stuck_restarts"], ["wifi_silent"])
        self.assertLessEqual(result["console_outages"], 1)
        self.assertEqual(bench.console.status()["wifi link"], "up")

    def test_a_stuck_restart_with_a_boot_that_takes_longer_than_a_command(self):
        bench = self.hanging_bench({"SIM_BOOT_TIME_MS": "5000"})
        result = bench.check_5()
        self.assertEqual(result["reasons"], ["wrong password"])
        self.assertEqual(result["stuck_restarts"], ["wifi_silent"])
        self.assertEqual(result["console_outages"], 1)

    def test_no_restart_is_no_outage(self):
        bench = self.bench_for({})
        result = bench.check_5()
        self.assertEqual(result["stuck_restarts"], [])
        self.assertEqual(result["console_outages"], 0)

    def test_a_console_that_stays_away_after_the_restart_fails(self):
        # One outage for the one restart. After that, keeping the console answering is the point.
        bench = self.hanging_bench({"SIM_WRONG_PASSWORD_REASONS": "no answer"})
        real = bench.console.get_id
        calls = []

        def answers_until_the_restart():
            if bench.seen_since(ota_bench.STUCK_RESTART, 0):
                calls.append(1)
                raise BoardError("does not answer: is it restarting?")
            return real()

        bench.console.get_id = answers_until_the_restart
        with self.assertRaisesRegex(BoardError, "does not answer"):
            bench.check_5()
        self.assertEqual(len(calls), 2)
        bench.console.get_id = real

    def test_a_restart_much_too_soon_fails(self):
        # What a timer that fires far too early on a healthy chip looks like.
        self.short_limit()
        bench = self.bench_for({"SIM_CHIP_HANGS": "1"})
        bench.args.join_timeout = 30
        with self.assertRaisesRegex(TestFailedError, "wifi_silent fired after"):
            bench.check_5()

    def test_a_fatal_error_next_to_the_restart_fails(self):
        bench = self.hanging_bench()
        real = bench.link.on_line

        def with_a_crash(line):
            real(line)
            if ota_bench.STUCK_RESTART.match(line):
                real(">>> ZEPHYR FATAL ERROR 0: CPU exception on CPU 0")

        bench.link.on_line = with_a_crash
        with self.assertRaisesRegex(TestFailedError, "fatal error"):
            bench.check_5()

    def test_a_fatal_error_with_no_restart_fails(self):
        bench = self.bench_for({})
        real = bench.link.on_line

        def with_a_crash(line):
            real(line)
            if "wrong password" in line:
                real("ASSERTION FAIL [work != NULL]")

        bench.link.on_line = with_a_crash
        with self.assertRaisesRegex(TestFailedError, "fatal error"):
            bench.check_5()

    def test_the_wrong_timer_fails(self):
        bench = self.hanging_bench()
        real = bench.link.on_line
        bench.link.on_line = lambda line: real(line.replace("reason=wifi_silent", "reason=update_stall"))
        with self.assertRaisesRegex(TestFailedError, "update_stall"):
            bench.check_5()

    def test_a_restart_with_no_driver_line_fails(self):
        bench = self.hanging_bench()
        real = bench.link.on_line
        bench.link.on_line = lambda line: None if ota_bench.DRIVER_HANG.search(line) else real(line)
        with self.assertRaisesRegex(TestFailedError, "no line from the driver"):
            bench.check_5()

    def test_a_board_that_does_not_answer_with_no_stuck_line_still_fails(self):
        bench = self.bench_for({"SIM_WRONG_PASSWORD_REASONS": ""})
        bench.args.join_timeout = 30
        real = bench.console.get_id
        bench.console.get_id = mock.Mock(side_effect=BoardError("does not answer: is it restarting?"))
        with self.assertRaisesRegex(BoardError, "does not answer"):
            bench.check_5()
        bench.console.get_id = real

    def test_a_hang_with_no_restart_fails_fast_and_the_network_goes_back(self):
        bench = self.bench_for({"SIM_CHIP_HANGS": "0"})
        bench.args.join_timeout = 600
        started = time.time()
        with mock.patch.object(ota_bench, "HANG_PATIENCE_SECONDS", 0.5):
            with self.assertRaises(ChipStuck):
                bench.check_5()
        self.assertLess(time.time() - started, 30)
        self.assertNotIn(console_bench.WRONG_NETWORK, bench.undone)
        self.assertEqual(bench.console.status()["wifi link"], "up")

    def test_any_wait_for_a_line_gives_up_on_a_hang(self):
        bench = self.bench_for({"SIM_CHIP_HANGS": "0"})
        final = bench.console.exchange(bench.wifi_command("wrong-password"), 8)[1]
        self.assertTrue(final.startswith("OK saved"))
        started = time.time()
        with mock.patch.object(ota_bench, "HANG_PATIENCE_SECONDS", 0.3), \
                self.assertRaises(ChipStuck):
            bench.wait_line(console_bench.WIFI_CONNECTED, 600, bench.mark())
        self.assertLess(time.time() - started, 10)

    def test_a_hang_that_ends_a_step_is_on_record_and_cleared(self):
        bench = self.bench_for({"SIM_CHIP_HANGS": "0"})
        bench.args.join_timeout = 600

        def hangs():
            bench.console.exchange(bench.wifi_command("wrong-password"), 8)
            bench.wait_line(console_bench.WIFI_CONNECTED, 600, bench.mark())

        with mock.patch.object(ota_bench, "HANG_PATIENCE_SECONDS", 0.3):
            self.assertFalse(bench.run_step(console_bench.Step("hangs", "x", hangs)))
        self.assertTrue(bench.results[-1]["chip_stuck"])
        self.assertFalse(bench.watch.hung())
        self.assertEqual(bench.console.get_id()[0], "ABC123")

    def test_a_network_name_does_not_get_into_the_results(self):
        bench = self.bench_for({})
        name = "Tester\u2019s iPhone"
        bench.credentials = (name, PASSWORD, "WPA2_PSK")
        step = console_bench.Step("broken", "x", lambda: (_ for _ in ()).throw(
            TestFailedError(f"answered OK saved, connecting to {name} with {PASSWORD}")))
        self.assertFalse(bench.run_step(step))
        text = (Path(bench.out) / "results.jsonl").read_text()
        self.assertIn("connecting to <network> with <secret>", text)
        self.assertNotIn("iPhone", text)
        self.assertNotIn(PASSWORD, text)

    def test_what_names_the_account_does_not_get_into_the_results(self):
        bench = self.bench_for({})
        outputs = Path(bench.out) / "outputs.json"
        outputs.write_text(json.dumps({"Region": "us-east-1", "FirmwareBucketName": "the-bucket-name"}))
        arn = "arn:aws:iot:us-east-1:123456789012:thing/cranium-x"

        def fails():
            raise TestFailedError(f"aws iot: {arn} in account 123456789012, with the-bucket-name")

        with mock.patch.object(console_bench, "OUTPUTS", outputs):
            self.assertFalse(bench.run_step(console_bench.Step("broken", "x", fails)))
        text = (Path(bench.out) / "results.jsonl").read_text()
        self.assertIn("aws iot: <account> in account <account>, with <account>", text)
        for word in ("arn:", "123456789012", "the-bucket-name"):
            self.assertNotIn(word, text)

    def test_a_hang_on_record_says_why_the_firmware_may_still_have_been_waiting(self):
        bench = self.bench_for({"SIM_CHIP_HANGS": "0"})

        def hangs():
            bench.console.exchange(bench.wifi_command("wrong-password"), 8)
            bench.wait_line(console_bench.WIFI_CONNECTED, 600, bench.mark())

        with mock.patch.object(ota_bench, "HANG_PATIENCE_SECONDS", 0.3):
            self.assertFalse(bench.run_step(console_bench.Step("hangs", "x", hangs)))
        error = bench.results[-1]["error"]
        self.assertIn("the bench has stopped waiting", error)
        self.assertIn("stuck count 0", error)
        self.assertIn("update idle", error)


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


class WifiWatchTest(unittest.TestCase):
    """When a bench stops waiting for a join. This goes by the board's lines and a clock."""

    DRIVER = "[wifi_nrf_bus] ERR: hal_rpu_ready_wait: Timed out waiting (msg_type = 0)"

    def setUp(self):
        self.now = 1000.0
        self.watch = WifiWatch(clock=lambda: self.now)

    def hang_for(self, seconds, every=2):
        for _ in range(int(seconds / every)):
            self.watch.feed(self.DRIVER)
            self.now += every

    def test_the_incident_stops_the_wait_soon_after_the_board_should_have_restarted(self):
        self.watch.feed("[WIFI] disconnected")
        self.hang_for(ota_bench.HANG_PATIENCE_SECONDS - 2)
        self.watch.feed(self.DRIVER)
        self.watch.check()
        self.watch.feed("[WIFI] failed reason=no answer")
        self.now += 2
        self.watch.feed(self.DRIVER)
        with self.assertRaisesRegex(ChipStuck, "stopped answering"):
            self.watch.check()

    def test_each_of_the_drivers_lines_counts(self):
        for line in (self.DRIVER, "[x] ERR: hal_rpu_cmd: Timeout waiting to get free cmd buff from RPU",
                     "[x] ERR: hal_rpu_ps_wake: RPU is not ready for more than 1 sec,reg_val = 0x0"):
            watch = WifiWatch(clock=lambda: self.now)
            watch.feed(line)
            self.assertIsNotNone(watch.first, line)

    def test_a_missing_hotspot_never_stops_the_wait(self):
        for _ in range(82):
            self.watch.feed("[WIFI] failed reason=network not found")
            self.now += 30
            self.watch.check()

    def test_no_answer_alone_is_not_a_hang(self):
        # It also comes on a healthy chip, associated on a network whose DHCP gives no address.
        for _ in range(20):
            self.watch.feed("[WIFI] failed reason=no answer")
            self.now += 30
            self.watch.check()

    def test_a_real_answer_ends_it(self):
        for line in ("[WIFI] connected ip=1.2.3.4 rssi=-51", "[WIFI] failed reason=wrong password",
                     "[WIFI] failed reason=network not found", "[BOOT] | State     OPERATING"):
            self.hang_for(ota_bench.HANG_PATIENCE_SECONDS)
            self.watch.feed(line)
            self.watch.check()
            self.assertFalse(self.watch.hung(), line)

    def test_no_answer_and_a_refused_request_do_not_end_it(self):
        for line in ("[WIFI] failed reason=no answer", "[WIFI] failed reason=request refused"):
            watch = WifiWatch(clock=lambda: self.now)
            watch.feed(self.DRIVER)
            watch.feed(line)
            self.assertIsNotNone(watch.first, line)

    def test_a_stuck_restart_ends_it_and_is_remembered(self):
        self.hang_for(ota_bench.HANG_PATIENCE_SECONDS)
        self.watch.feed("[STUCK] restarting reason=wifi_silent count=1")
        self.watch.check()
        self.assertEqual(self.watch.restarts, ["wifi_silent"])

    def test_a_few_lines_that_stop_again_are_no_hang(self):
        self.watch.feed(self.DRIVER)
        self.now += ota_bench.HANG_PATIENCE_SECONDS + ota_bench.HANG_QUIET_SECONDS + 1
        self.assertFalse(self.watch.hung())

    def test_two_lines_far_apart_are_no_hang(self):
        for gap in (ota_bench.HANG_PATIENCE_SECONDS, 3600, 3 * 3600):
            self.watch.feed(self.DRIVER)
            self.now += gap
            self.watch.feed(self.DRIVER)
            self.assertFalse(self.watch.hung(), gap)
            self.watch.check()
            self.watch.clear()

    def test_lines_just_too_far_apart_are_not_the_same_hang(self):
        for _ in range(20):
            self.watch.feed(self.DRIVER)
            self.now += ota_bench.HANG_QUIET_SECONDS + 1
            self.watch.feed(self.DRIVER)
            self.assertFalse(self.watch.hung())

    def test_lines_as_far_apart_as_it_allows_are_the_same_hang(self):
        started = self.now
        while self.now - started < ota_bench.HANG_PATIENCE_SECONDS:
            self.watch.feed(self.DRIVER)
            self.now += ota_bench.HANG_QUIET_SECONDS
        self.watch.feed(self.DRIVER)
        self.assertTrue(self.watch.hung())

    def test_a_hang_after_an_old_line_counts_from_where_it_began(self):
        self.watch.feed(self.DRIVER)
        self.now += 3600
        self.hang_for(ota_bench.HANG_PATIENCE_SECONDS - 2)
        self.watch.feed(self.DRIVER)
        self.assertFalse(self.watch.hung())
        self.now += 2
        self.watch.feed(self.DRIVER)
        self.assertTrue(self.watch.hung())

    def test_it_says_that_the_bench_gave_up_and_not_that_the_board_failed(self):
        self.hang_for(ota_bench.HANG_PATIENCE_SECONDS + 2)
        with self.assertRaises(ChipStuck) as caught:
            self.watch.check()
        self.assertIn("the bench has stopped waiting", str(caught.exception))
        self.assertNotIn("has not restarted", str(caught.exception))

    def test_what_a_hang_on_record_says_about_the_board(self):
        self.assertEqual(ota_bench.hang_context({"stuck count": "2", "update": "idle (last: none)"}),
                         " (stuck count 2, update idle (last: none))")
        self.assertIn("not known", ota_bench.hang_context(None))

    def test_a_clear_from_the_port_in_the_middle_of_a_check(self):
        # The reader's thread can clear it between what check() looks at and what it says.
        self.hang_for(ota_bench.HANG_PATIENCE_SECONDS + 2)
        self.watch.feed(self.DRIVER)

        def clock():
            self.watch.clear()
            return self.now

        self.watch.clock = clock
        with self.assertRaises(ChipStuck):
            self.watch.check()
        self.assertFalse(self.watch.hung())

    def test_the_two_threads_do_not_get_in_each_others_way(self):
        watch = WifiWatch()
        stopping = threading.Event()

        def port():
            while not stopping.is_set():
                watch.feed(self.DRIVER)
                watch.clear()

        interval = sys.getswitchinterval()
        sys.setswitchinterval(1e-6)
        thread = threading.Thread(target=port)
        thread.start()
        try:
            with mock.patch.object(ota_bench, "HANG_PATIENCE_SECONDS", 0):
                deadline = time.time() + 0.5
                while time.time() < deadline:
                    try:
                        watch.check()
                    except ChipStuck:
                        pass
        finally:
            stopping.set()
            thread.join()
            sys.setswitchinterval(interval)


class ScrubTest(unittest.TestCase):
    """What gets taken out of what goes into results.jsonl, and what must not be."""

    def test_what_says_whose_account_this_is(self):
        for text in ("arn:aws:sts::123456789012:assumed-role/the-role/session",
                     "arn:aws:iot:us-east-1:123456789012:thing/cranium-abc",
                     "abc123-ats.iot.us-east-1.amazonaws.com",
                     "https://s3.us-east-1.amazonaws.com/the-bucket/firmware/x.bin",
                     "123456789012"):
            scrubbed = ota_bench.scrub(f"before {text}, after", [])
            self.assertEqual(scrubbed.replace("https://", ""), "before <account>, after", text)

    def test_what_looks_like_it_and_is_not(self):
        for text in ("cranium-bench-20261101T081741-ab12", "a" * 64, "1234567890123", "12345678901",
                     "1.6.9+0", "2026-11-01T10:00:00", "ip 192.168.1.42"):
            self.assertEqual(ota_bench.scrub(text, []), text)

    def test_names_of_any_length(self):
        self.assertEqual(ota_bench.scrub("a bucket/prefix and a bucket", ["bucket", "bucket/prefix"],
                                         "<x>"), "a <x> and a <x>")
        self.assertEqual(ota_bench.scrub("nothing", [""]), "nothing")

    def test_through_a_result(self):
        value = {"bootloader": ["on Net"], "why": "Net", "nested": {"a": ("Net",)}, "seconds": 3}
        self.assertEqual(ota_bench.scrub(value, ["Net"]),
                         {"bootloader": ["on <network>"], "why": "<network>",
                          "nested": {"a": ["<network>"]}, "seconds": 3})

    def test_the_benchs_own_fields_stay_as_they_are(self):
        digest = "aa11cafe22bb" + "0" * 52
        record = {"to": "1.6.9+0", "from": "1.6.8+0", "sha256": digest, "job": "cafe-job",
                  "running": "1.6.9+0", "firmware": "1.6.9+0", "trial_job": "cafe-job"}
        self.assertEqual(ota_bench.scrub(record, ["cafe", "1.6"]), record)

    def test_the_names_in_the_outputs_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "outputs.json"
            self.assertEqual(ota_bench.account_names_in(path), set())
            path.write_text("not json")
            self.assertEqual(ota_bench.account_names_in(path), set())
            path.write_text(json.dumps({"Region": "us-east-1", "DeployedCommit": "abc", "DeployedTree": "def",
                                        "FirmwareBucketName": "b", "IotEndpoint": "e", "Number": 3}))
            self.assertEqual(ota_bench.account_names_in(path), {"b", "e"})


class StuckDuringJoinVerdictTest(unittest.TestCase):
    """Which restart check-5 lets pass, on the way to reporting a wrong password."""

    STARTED = 1000.0
    LIMIT = ota_bench.WIFI_SILENT_SECONDS
    DRIVER = "[wifi_nrf_bus] ERR: hal_rpu_ready_wait: Timed out waiting (msg_type = 0)"

    def lines(self, waited=LIMIT, reason="wifi_silent", count=1, extra=()):
        return [(self.STARTED + 4, "[WIFI] disconnected"),
                (self.STARTED + 10, self.DRIVER),
                *extra,
                (self.STARTED + 4 + waited, f"[STUCK] restarting reason={reason} count={count}"),
                (self.STARTED + 4 + waited + 20, "[WIFI] failed reason=wrong password")]

    def judge(self, lines):
        return ota_bench.judge_stuck_during_join(lines, self.STARTED)

    def test_nothing_happened(self):
        self.assertEqual(self.judge([]), [])
        self.assertEqual(self.judge([(self.STARTED + 1, "[WIFI] failed reason=wrong password")]), [])

    def test_a_restart_at_the_limit(self):
        self.assertEqual(self.judge(self.lines()), ["wifi_silent"])

    def test_the_bounds(self):
        slack = ota_bench.BOUND_SLACK_SECONDS
        self.judge(self.lines(self.LIMIT - slack))
        self.judge(self.lines(self.LIMIT + slack))
        with self.assertRaisesRegex(TestFailedError, "fired after"):
            self.judge(self.lines(self.LIMIT - slack - 1))
        with self.assertRaisesRegex(TestFailedError, "fired after"):
            self.judge(self.lines(self.LIMIT + slack + 1))

    def test_a_count_above_1_has_no_upper_bound_because_of_the_back_off(self):
        self.judge(self.lines(6 * 3600, count=4))
        with self.assertRaisesRegex(TestFailedError, "fired after"):
            self.judge(self.lines(self.LIMIT - ota_bench.BOUND_SLACK_SECONDS - 1, count=4))

    def test_the_silence_counts_from_the_last_thing_the_stack_said(self):
        answered = [(self.STARTED + 60, "[WIFI] failed reason=network not found")]
        self.judge(self.lines(56 + self.LIMIT, extra=answered))
        with self.assertRaisesRegex(TestFailedError, "fired after"):
            self.judge(self.lines(56 + 10, extra=answered))

    def test_no_answer_is_not_the_stack_saying_something(self):
        extra = [(self.STARTED + 34, "[WIFI] failed reason=no answer"),
                 (self.STARTED + 64, "[WIFI] failed reason=no answer")]
        self.judge(self.lines(extra=extra))

    def test_with_no_line_about_the_link_it_counts_from_the_command(self):
        lines = [line for line in self.lines(self.LIMIT - 4) if "disconnected" not in line[1]]
        self.judge(lines)
        lines = [line for line in self.lines(0) if "disconnected" not in line[1]]
        lines.insert(0, (self.STARTED + 2, self.DRIVER))
        with self.assertRaisesRegex(TestFailedError, "fired after"):
            self.judge(lines)

    def test_two_restarts_fail(self):
        lines = self.lines() + [(self.STARTED + 200, "[STUCK] restarting reason=wifi_silent count=2")]
        with self.assertRaisesRegex(TestFailedError, "2 restarts"):
            self.judge(lines)

    def test_another_timer_fails(self):
        for reason in ("no_cloud", "update_stall"):
            with self.assertRaisesRegex(TestFailedError, reason):
                self.judge(self.lines(reason=reason))

    def test_no_driver_line_before_it_fails(self):
        lines = [line for line in self.lines() if line[1] != self.DRIVER]
        with self.assertRaisesRegex(TestFailedError, "no line from the driver"):
            self.judge(lines)
        lines.append((self.STARTED + 300, self.DRIVER))
        with self.assertRaisesRegex(TestFailedError, "no line from the driver"):
            self.judge(lines)

    def test_a_fatal_error_fails_with_or_without_a_restart(self):
        fatal = (self.STARTED + 50, ">>> ZEPHYR FATAL ERROR 0: CPU exception on CPU 0")
        with self.assertRaisesRegex(TestFailedError, "fatal error"):
            self.judge(self.lines(extra=[fatal]))
        with self.assertRaisesRegex(TestFailedError, "fatal error"):
            self.judge([fatal])


class StuckRestartVerdictTest(unittest.TestCase):
    """What counts as the board having restarted itself as it should, from a run's lines."""

    STARTED = 1000.0
    BOOT = ["*** Booting MCUboot ***", "Starting bootloader", "Jumping to the first image slot"]

    def lines(self, reason="no_cloud", waited=None, count=1, extra=(), said_at_boot=None):
        limit = ota_bench.NO_CLOUD_SECONDS if reason == "no_cloud" else ota_bench.WIFI_SILENT_SECONDS
        waited = limit if waited is None else waited
        mark = self.STARTED + 80
        going = "[app] Disconnected from AWS IoT" if reason == "no_cloud" else "[WIFI] disconnected"
        boot_says = (said_at_boot if said_at_boot is not None else
                     f"[stuck] WRN: Restarted earlier for being stuck: reason={reason} count={count}")
        return [(self.STARTED + 1, "[WIFI] test image: chip power cut"),
                (self.STARTED + 40, "[wifi_nrf_bus] ERR: hal_rpu_ps_wake: RPU is not ready"),
                (mark, going),
                *extra,
                (mark + waited, f"[STUCK] restarting reason={reason} count={count}"),
                (mark + waited + 3, "[BOOT] | State     OPERATING"),
                (mark + waited + 3, boot_says),
                (mark + waited + 20, "[WIFI] connected ip=192.168.1.42 rssi=-51"),
                (mark + waited + 30, "[app] Connected to AWS IoT")]

    def judge(self, lines, boot=None, count_before=0):
        return ota_bench.judge_stuck_restart(lines, self.BOOT if boot is None else boot,
                                             self.STARTED, count_before)

    def test_each_timer_at_its_limit(self):
        verdict = self.judge(self.lines("no_cloud"))
        self.assertEqual(verdict["reason"], "no_cloud")
        self.assertEqual(verdict["fired_after"], ota_bench.NO_CLOUD_SECONDS)
        self.assertEqual(verdict["seconds_from_command"], 80 + ota_bench.NO_CLOUD_SECONDS)

        verdict = self.judge(self.lines("wifi_silent"))
        self.assertEqual(verdict["reason"], "wifi_silent")
        self.assertEqual(verdict["fired_after"], ota_bench.WIFI_SILENT_SECONDS)

    def test_too_early_and_too_late_both_fail(self):
        for reason, limit in (("no_cloud", ota_bench.NO_CLOUD_SECONDS),
                              ("wifi_silent", ota_bench.WIFI_SILENT_SECONDS)):
            slack = ota_bench.BOUND_SLACK_SECONDS
            self.judge(self.lines(reason, waited=limit + slack))
            self.judge(self.lines(reason, waited=limit - slack))
            with self.assertRaisesRegex(TestFailedError, "its limit is"):
                self.judge(self.lines(reason, waited=limit + slack + 1))
            with self.assertRaisesRegex(TestFailedError, "its limit is"):
                self.judge(self.lines(reason, waited=limit - slack - 1))

    def test_an_answer_after_the_link_went_moves_the_mark_of_the_silence(self):
        extra = [(self.STARTED + 150, "[WIFI] failed reason=network not found")]
        verdict = self.judge(self.lines("wifi_silent", waited=70 + ota_bench.WIFI_SILENT_SECONDS,
                                        extra=extra))
        self.assertEqual(verdict["fired_after"], ota_bench.WIFI_SILENT_SECONDS)

    def test_the_wrong_timer_fails(self):
        lines = self.lines("no_cloud")
        changed = [(at, text.replace("no_cloud", "update_stall")) for at, text in lines]
        with self.assertRaisesRegex(TestFailedError, "nothing to do with this"):
            self.judge(changed)

    def test_a_timer_with_no_sign_of_what_started_it_fails(self):
        lines = [line for line in self.lines("no_cloud") if "Disconnected" not in line[1]]
        with self.assertRaisesRegex(TestFailedError, "the cloud went"):
            self.judge(lines)
        lines = [line for line in self.lines("wifi_silent") if "disconnected" not in line[1]]
        with self.assertRaisesRegex(TestFailedError, "the link went"):
            self.judge(lines)

    def test_no_line_or_two_lines_fail(self):
        lines = self.lines()
        with self.assertRaisesRegex(TestFailedError, "0 .STUCK. lines"):
            self.judge([line for line in lines if "[STUCK]" not in line[1]])
        with self.assertRaisesRegex(TestFailedError, "2 .STUCK. lines"):
            self.judge(lines + [(lines[-1][0] + 1, "[STUCK] restarting reason=no_cloud count=2")])

    def test_the_count_has_to_be_the_next_one(self):
        with self.assertRaisesRegex(TestFailedError, "count=2"):
            self.judge(self.lines(count=2))
        self.judge(self.lines(count=2), count_before=1)

    def test_a_crash_is_not_the_timers_restart(self):
        extra = [(self.STARTED + 200, "[os] >>> ZEPHYR FATAL ERROR 0: CPU exception on CPU 0")]
        with self.assertRaisesRegex(TestFailedError, "fatal error"):
            self.judge(self.lines(extra=extra))
        extra = [(self.STARTED + 200, "ASSERTION FAIL [work != NULL]")]
        with self.assertRaisesRegex(TestFailedError, "fatal error"):
            self.judge(self.lines(extra=extra))

    def test_a_revert_or_a_second_boot_or_no_boot_fail(self):
        with self.assertRaisesRegex(TestFailedError, "reverted"):
            self.judge(self.lines(), self.BOOT + ["Swap type: revert"])
        with self.assertRaisesRegex(TestFailedError, "reverted"):
            self.judge(self.lines(), self.BOOT + ["Swap type: test"])
        with self.assertRaisesRegex(TestFailedError, "2 boots"):
            self.judge(self.lines(), self.BOOT + self.BOOT)
        with self.assertRaisesRegex(TestFailedError, "0 boots"):
            self.judge(self.lines(), [])
        with self.assertRaisesRegex(TestFailedError, "starting the image"):
            self.judge(self.lines(), ["Starting bootloader"])

    def test_the_next_boot_has_to_report_it(self):
        with self.assertRaisesRegex(TestFailedError, "next boot"):
            self.judge(self.lines(said_at_boot="[app] nothing about it"))
        with self.assertRaisesRegex(TestFailedError, "next boot"):
            self.judge(self.lines(said_at_boot="[stuck] WRN: x reason=wifi_silent count=1"))
        with self.assertRaisesRegex(TestFailedError, "next boot"):
            self.judge(self.lines(said_at_boot="[stuck] WRN: x reason=no_cloud count=2"))

    def test_it_has_to_join_again_with_an_address(self):
        lines = [line for line in self.lines() if "connected ip=" not in line[1]]
        with self.assertRaisesRegex(TestFailedError, "joined"):
            self.judge(lines)
        lines = [(at, text.replace("ip=192.168.1.42", "ip=none")) for at, text in self.lines()]
        with self.assertRaisesRegex(TestFailedError, "joined"):
            self.judge(lines)

    def test_what_it_said_before_the_restart_does_not_count_for_after_it(self):
        lines = self.lines()
        at = next(when for when, text in lines if "[STUCK]" in text)
        early_join = [line for line in lines if "connected ip=" not in line[1]]
        early_join.insert(1, (self.STARTED + 2, "[WIFI] connected ip=192.168.1.42 rssi=-51"))
        with self.assertRaisesRegex(TestFailedError, "joined"):
            self.judge(early_join)

        said_too_early = [line for line in lines if "[stuck] WRN" not in line[1]]
        said_too_early.insert(1, (at - 1, "[stuck] WRN: Restarted earlier: reason=no_cloud count=1"))
        with self.assertRaisesRegex(TestFailedError, "next boot"):
            self.judge(said_too_early)

    def test_the_cloud_timer_counts_from_the_first_time_the_cloud_went(self):
        # The line comes again for every failed attempt to connect.
        again = [(self.STARTED + 80 + 300, "[app] Disconnected from AWS IoT"),
                 (self.STARTED + 80 + 600, "[app] Disconnected from AWS IoT")]
        verdict = self.judge(self.lines("no_cloud", extra=again))
        self.assertEqual(verdict["fired_after"], ota_bench.NO_CLOUD_SECONDS)

    def test_a_restart_with_no_sign_that_the_chip_stopped_fails(self):
        # A hotspot that lost its internet for as long as the timer takes would look like this.
        lines = [line for line in self.lines("no_cloud") if "not ready" not in line[1]]
        with self.assertRaisesRegex(TestFailedError, "no line from the driver"):
            self.judge(lines)

        # After the restart it is too late to count.
        at = next(when for when, text in lines if "[STUCK]" in text)
        lines.append((at + 1, "[wifi_nrf_bus] ERR: hal_rpu_ps_wake: RPU is not ready"))
        with self.assertRaisesRegex(TestFailedError, "no line from the driver"):
            self.judge(lines)

    def test_the_verdict_says_how_many_driver_lines_there_were(self):
        self.assertEqual(self.judge(self.lines())["driver_lines"], 1)
        extra = [(self.STARTED + 100, "[x] ERR: hal_rpu_ready_wait: Timed out waiting"),
                 (self.STARTED + 102, "[x] ERR: x: Timeout waiting to get free cmd buff from RPU")]
        self.assertEqual(self.judge(self.lines(extra=extra))["driver_lines"], 3)

    def test_nothing_the_board_said_is_in_the_verdict(self):
        name = "SomeNetworkName"
        lines = self.lines() + [(self.STARTED + 5, f"[net] Leaving {name}")]
        self.assertNotIn(name, json.dumps(self.judge(lines)))

    def test_the_limits_are_the_boards(self):
        source = (REPO / "firmware/app/src/stuck_policy.h").read_text()

        def limit(name):
            text = re.search(rf"#define {name}\s+(.+)", source).group(1)
            return eval(text, {"__builtins__": {}})  # A number, or two multiplied.

        self.assertEqual(ota_bench.WIFI_SILENT_SECONDS, limit("STUCK_WIFI_SILENT_SECONDS"))
        self.assertEqual(ota_bench.NO_CLOUD_SECONDS, limit("STUCK_NO_CLOUD_SECONDS"))
        self.assertGreater(ota_bench.HANG_PATIENCE_SECONDS, ota_bench.WIFI_SILENT_SECONDS)
        self.assertGreater(ota_bench.CHIP_DEAD_WAIT_SECONDS, ota_bench.NO_CLOUD_SECONDS)


class FaultIsCompiledOutTest(unittest.TestCase):
    """The fault that stops the Wi-Fi chip never gets into an image a release could come from."""

    SRC = REPO / "firmware/app/src"
    QUEUE = "CONFIG_NET_MGMT_EVENT_QUEUE_SIZE=16\n"
    CLEAN = "CONFIG_NRF_WIFI_RPU_RECOVERY=y\n" + QUEUE
    FAULT = "CONFIG_APP_TEST_FAULT_WIFI_DEAD=y\n# CONFIG_NRF_WIFI_RPU_RECOVERY is not set\n" + QUEUE
    MARKED = b"x" + b"\0".join(fault_check.MARKERS) + b"y"

    def test_a_clean_build(self):
        self.assertEqual(fault_check.problems_of_clean(self.CLEAN, b"nothing"), [])

    def test_what_a_clean_build_must_not_have(self):
        self.assertTrue(fault_check.problems_of_clean(self.FAULT + self.CLEAN, b"nothing"))
        self.assertTrue(fault_check.problems_of_clean("", b"nothing"))
        for marker in fault_check.MARKERS:
            self.assertTrue(fault_check.problems_of_clean(self.CLEAN, b"a" + marker + b"b"), marker)

    def test_the_fault_build_is_the_positive_control(self):
        self.assertEqual(fault_check.problems_of_fault(self.FAULT, self.MARKED), [])
        self.assertTrue(fault_check.problems_of_fault(self.CLEAN, self.MARKED))
        self.assertTrue(fault_check.problems_of_fault(self.FAULT + self.CLEAN, self.MARKED))
        for marker in fault_check.MARKERS:
            self.assertTrue(fault_check.problems_of_fault(self.FAULT,
                                                          self.MARKED.replace(marker, b"")), marker)

    def test_each_kind_of_image_has_the_same_event_queue(self):
        # Without the driver's recovery, its Kconfig would leave this at 5.
        for check, config, image in ((fault_check.problems_of_clean, self.CLEAN, b"nothing"),
                                     (fault_check.problems_of_fault, self.FAULT, self.MARKED)):
            self.assertEqual(check(config, image), [])
            self.assertTrue(check(config.replace(self.QUEUE, ""), image))
            small = config.replace(self.QUEUE, "CONFIG_NET_MGMT_EVENT_QUEUE_SIZE=5\n")
            self.assertTrue(check(small, image))

    def test_the_application_sets_the_size_of_that_queue(self):
        config = (REPO / "firmware/app/prj.conf").read_text()
        self.assertIn(self.QUEUE, config)

    def test_the_strings_are_where_the_firmware_has_them(self):
        self.assertIn(fault_check.MARKERS[0].decode(), (self.SRC / "fault_wifi.c").read_text())
        self.assertIn(f'"{fault_check.MARKERS[1].decode()}"', (self.SRC / "console_cmd.c").read_text())

    def test_only_one_file_touches_the_chips_pins(self):
        for path in self.SRC.iterdir():
            if path.name == "fault_wifi.c":
                continue
            # What only that image compiles can talk about them: the next test looks at that.
            text = re.sub(r"#if defined\(CONFIG_APP_TEST_FAULT_WIFI_DEAD\).*?#endif", "", path.read_text(),
                          flags=re.DOTALL)
            for word in ("bucken", "iovdd", "rpu_drv_priv_zep"):
                self.assertNotIn(word, text.lower(), path.name)

    def test_that_file_goes_in_with_the_option_only(self):
        lists = (REPO / "firmware/app/CMakeLists.txt").read_text()
        self.assertEqual(lists.count("fault_wifi.c"), 1)
        self.assertRegex(lists, r"target_sources_ifdef\(CONFIG_APP_TEST_FAULT_WIFI_DEAD app PRIVATE src/fault_wifi\.c\)")

    def test_the_build_stops_if_recovery_would_hide_it(self):
        lists = (REPO / "firmware/app/CMakeLists.txt").read_text()
        self.assertRegex(lists, r"if\(CONFIG_APP_TEST_FAULT_WIFI_DEAD AND CONFIG_NRF_WIFI_RPU_RECOVERY\)\s+message\(FATAL_ERROR")

    def test_the_command_is_behind_the_option_in_the_console(self):
        source = (self.SRC / "console_cmd.c").read_text()
        for name in ("cmd_test_wifi_dead", '"TEST_WIFI_DEAD"'):
            at = source.index(name)
            self.assertGreater(source.rfind("#if defined(CONFIG_APP_TEST_FAULT_WIFI_DEAD)", 0, at),
                               source.rfind("#endif", 0, at), name)

    def test_the_option_needs_the_console(self):
        config = (REPO / "firmware/app/Kconfig").read_text()
        self.assertRegex(config, r"config APP_TEST_FAULT_WIFI_DEAD\n\tbool [^\n]+\n\tdepends on APP_CONSOLE")

    def test_no_image_with_it_is_kept_in_binaries(self):
        import store_binary

        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / ".config"
            config.write_text(self.FAULT)
            self.assertTrue(store_binary.has_test_fault(config))


@unittest.skipUnless(FAULT_SIMULATOR.exists(), "run `make -C firmware/tests/host` first")
class ChipDeadScenarioTest(SimulatedBoard, unittest.TestCase):
    """The scenario from start to end, on the console's real code in a simulator, with the board's
    timers made up by it and shortened here. What a real chip does is for the bench to find out."""

    IMAGE = "wifi-dead.bin"

    def bench_for(self, environment=None):
        self.start_simulator(environment or {}, FAULT_SIMULATOR)
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        out = Path(self.folder.name)
        self.calls = []
        self.provision_board()

        test = self

        class Stand_in(ota_bench.Bench):
            def __init__(self):
                self.args = SimpleNamespace(real_button=False)
                self.out = out
                self.boot_lines = []
                self.console_log = []
                self.watch = WifiWatch()
                self.network_names = set()
                self.account_names = set()
                self.chip_stuck = False
                self.console = ota_bench.BenchConsole("/dev/simulated", out / "vcom1.log",
                                                      self.on_console_line)
                self.thing = None
                self.reported = {"version": None, "confirmed": True}
                self.reported_after_restart = None
                self.commands = []
                self.boot_says = test.BOOT
                real_write = self.console.serial.port.write

                def write(data):
                    self.commands.append(data)
                    real_write(data)

                self.console.serial.port.write = write

            def on_console_line(self, line):
                super().on_console_line(line)
                if ota_bench.STUCK_RESTART.match(line):
                    self.boot_lines += self.boot_says
                    self.reported = self.reported_after_restart or self.reported

            def shadow(self):
                return {"fw": self.reported}

            def close(self):
                self.console.serial.close()

        bench = Stand_in()
        self.addCleanup(bench.close)
        firmware = bench.console.get_id()[1]
        major, minor, rest = firmware.split(".")
        patch, build = rest.split("+")
        data = ((0x96f3b83d).to_bytes(4, "little") + b"\0" * 16 + bytes([int(major), int(minor)])
                + int(patch).to_bytes(2, "little") + int(build).to_bytes(4, "little") + b"\0" * 32)
        self.image = out / self.IMAGE
        self.image.write_bytes(data)
        self.digest = ota_bench.hashlib.sha256(data).hexdigest()
        self.firmware = firmware
        bench.reported = {"version": firmware, "confirmed": True}
        return bench

    BOOT = ["Starting bootloader", "Jumping to the first image slot"]

    def trial_on_record(self, bench, digest=None, outcome="PASS", to=None):
        with open(bench.out / "results.jsonl", "a") as file:
            file.write(json.dumps({"scenario": "update", "outcome": outcome, "at": "2026-11-01T10:00:00",
                                   "result": {"to": to or self.firmware, "job": "job-1",
                                              "sha256": digest or self.digest}}) + "\n")

    def shortened(self):
        patches = [mock.patch.object(ota_bench, "NO_CLOUD_SECONDS", 0.6),
                   mock.patch.object(ota_bench, "WIFI_SILENT_SECONDS", 0.6),
                   mock.patch.object(ota_bench, "BOUND_SLACK_SECONDS", 0.5),
                   mock.patch.object(ota_bench, "CHIP_DEAD_WAIT_SECONDS", 5),
                   mock.patch.object(ota_bench, "SHADOW_CATCH_UP_SECONDS", 0)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def run_it(self, bench):
        return ota_bench.run(bench, "chip-dead", ota_bench.Bench.chip_dead, self.image)

    def after_the_restart(self, bench, change):
        """What the board's status says from the restart on."""
        real = bench.console.status

        def status():
            said = any(ota_bench.STUCK_RESTART.match(line) for _, line in bench.console_log)
            return change(real()) if said else real()

        bench.console.status = status

    def failure_after_the_restart(self, environment=None):
        self.shortened()
        bench = self.bench_for({"SIM_DEAD_STUCK_MS": "600"} | (environment or {}))
        self.trial_on_record(bench)
        return bench

    def last_record(self, bench):
        return json.loads((bench.out / "results.jsonl").read_text().splitlines()[-1])

    def test_no_trial_on_record_means_it_does_not_run(self):
        self.shortened()
        bench = self.bench_for()
        self.assertFalse(self.run_it(bench))
        record = self.last_record(bench)
        self.assertEqual(record["outcome"], "NOT_RUN")
        self.assertIn("over-the-air trial", record["error"])
        self.assertNotIn(b"TEST_WIFI_DEAD\r", b"".join(bench.commands))

    def test_a_trial_of_another_image_or_one_that_failed_does_not_count(self):
        self.shortened()
        bench = self.bench_for()
        self.trial_on_record(bench, digest="0" * 64)
        self.trial_on_record(bench, outcome="FAIL")
        self.trial_on_record(bench, to="9.9.9+9")
        self.assertFalse(self.run_it(bench))
        self.assertEqual(self.last_record(bench)["outcome"], "NOT_RUN")
        self.assertNotIn(b"TEST_WIFI_DEAD\r", b"".join(bench.commands))

    def test_the_timer_for_the_cloud(self):
        self.shortened()
        bench = self.bench_for({"SIM_DEAD_STUCK_MS": "600"})
        self.trial_on_record(bench)
        self.assertTrue(self.run_it(bench), (bench.out / "results.jsonl").read_text())
        record = self.last_record(bench)
        self.assertEqual(record["outcome"], "PASS")
        self.assertEqual(record["result"]["reason"], "no_cloud")
        self.assertEqual(record["result"]["count"], 1)
        self.assertEqual(record["result"]["reset"], "software")
        self.assertIn("over-the-air trial", record["result"]["no_revert_means"])
        self.assertEqual(record["result"]["trial_job"], "job-1")

    def test_the_timer_for_silence(self):
        self.shortened()
        bench = self.bench_for({"SIM_DEAD_REASON": "wifi_silent", "SIM_DEAD_STUCK_MS": "600"})
        self.trial_on_record(bench)
        self.assertTrue(self.run_it(bench), (bench.out / "results.jsonl").read_text())
        self.assertEqual(self.last_record(bench)["result"]["reason"], "wifi_silent")

    def test_it_says_nothing_on_the_console_while_it_waits(self):
        self.shortened()
        bench = self.bench_for({"SIM_DEAD_STUCK_MS": "600"})
        self.trial_on_record(bench)
        sent_at_restart = []
        real = bench.on_console_line

        def noting(line):
            if ota_bench.STUCK_RESTART.match(line):
                sent_at_restart.extend(bench.commands)
            real(line)

        bench.console.serial.on_line = noting
        self.assertTrue(self.run_it(bench))
        sent = b"".join(sent_at_restart)
        self.assertEqual(sent.count(b"TEST_WIFI_DEAD\r"), 1)
        self.assertTrue(sent.endswith(b"TEST_WIFI_DEAD\r"), sent[-60:])

    def test_a_board_that_never_restarts_fails_and_is_restarted_by_hand(self):
        self.shortened()
        bench = self.bench_for({"SIM_DEAD_STUCK_MS": "100000"})
        self.trial_on_record(bench)
        self.assertFalse(self.run_it(bench))
        record = self.last_record(bench)
        self.assertEqual(record["outcome"], "FAIL")
        self.assertIn("no [STUCK] line", record["error"])
        self.assertIn(b"REBOOT\r", b"".join(bench.commands))

    def test_a_board_that_restarts_with_no_line_fails(self):
        self.shortened()
        bench = self.bench_for({"SIM_DEAD_STUCK_MS": "100000"})
        self.trial_on_record(bench)
        timer = threading.Timer(0.5, lambda: bench.boot_lines.extend(self.BOOT))
        timer.start()
        self.addCleanup(timer.cancel)
        self.assertFalse(self.run_it(bench))
        self.assertIn("without saying why", self.last_record(bench)["error"])

    def test_a_revert_fails(self):
        self.shortened()
        bench = self.bench_for({"SIM_DEAD_STUCK_MS": "600"})
        self.trial_on_record(bench)
        bench.boot_says = self.BOOT + ["Swap type: revert"]
        self.assertFalse(self.run_it(bench))
        self.assertIn("reverted", self.last_record(bench)["error"])

    def test_a_reset_that_is_not_software_fails(self):
        self.shortened()
        bench = self.bench_for({"SIM_DEAD_STUCK_MS": "600", "SIM_RESET_REASON": "watchdog"})
        self.trial_on_record(bench)
        self.assertFalse(self.run_it(bench))
        self.assertIn("the last reset was by watchdog", self.last_record(bench)["error"])

    def test_another_firmware_after_the_restart_fails(self):
        bench = self.failure_after_the_restart()
        self.after_the_restart(bench, lambda status: status | {"firmware": "1.5.0+0"})
        self.assertFalse(self.run_it(bench))
        self.assertIn("reverted", self.last_record(bench)["error"])

    def test_a_shadow_that_is_not_confirmed_after_the_restart_fails(self):
        bench = self.failure_after_the_restart()
        bench.reported_after_restart = {"version": self.firmware, "confirmed": False}
        self.assertFalse(self.run_it(bench))
        self.assertIn("shadow says", self.last_record(bench)["error"])

    def test_a_shadow_that_is_not_confirmed_before_the_command_touches_nothing(self):
        bench = self.failure_after_the_restart()
        bench.reported = {"version": self.firmware, "confirmed": False}
        self.assertFalse(self.run_it(bench))
        self.assertIn("shadow says", self.last_record(bench)["error"])
        self.assertNotIn(b"TEST_WIFI_DEAD\r", b"".join(bench.commands))

    def test_a_cloud_that_never_comes_back_fails(self):
        bench = self.failure_after_the_restart()
        self.after_the_restart(bench, lambda status: status | {"cloud": "not connected"})
        real = bench.wait_online
        said = lambda: any(ota_bench.STUCK_RESTART.match(line) for _, line in bench.console_log)  # noqa: E731
        bench.wait_online = lambda timeout=240: real(1 if said() else timeout)
        self.assertFalse(self.run_it(bench))
        self.assertIn("connected and idle", self.last_record(bench)["error"])

    def test_a_command_that_is_refused_fails_at_once(self):
        bench = self.failure_after_the_restart({"SIM_DEAD_STUCK_MS": "100000"})
        real = bench.console.exchange

        def exchange(command, *args, **kwargs):
            if command == ota_bench.DEAD_COMMAND:
                return [], "ERR this image has no trailer, so a revert could not show"
            return real(command, *args, **kwargs)

        bench.console.exchange = exchange
        self.assertFalse(self.run_it(bench))
        self.assertIn("answered: ERR", self.last_record(bench)["error"])

    def test_a_restart_with_no_driver_line_fails(self):
        bench = self.failure_after_the_restart()
        real = bench.on_console_line
        bench.console.serial.on_line = (lambda line: None if ota_bench.DRIVER_HANG.search(line)
                                        else real(line))
        self.assertFalse(self.run_it(bench))
        self.assertIn("no line from the driver", self.last_record(bench)["error"])

    def test_the_record_of_a_real_update_is_what_it_goes_by(self):
        # Bench.update() from start to end, with only the cloud played by stand-ins, and not a
        # record written by hand as elsewhere here.
        bench = self.failure_after_the_restart()
        (bench.out / "results.jsonl").unlink()
        bench.offer = lambda data, name: ("job-real", ota_bench.image_version(data))
        bench.wait_offered = lambda job: None
        bench.press = lambda button: None
        bench.wait_job = lambda job, timeout, follow=None: {"status": "SUCCEEDED"}
        self.assertTrue(ota_bench.run(bench, "update", ota_bench.Bench.update, self.image))
        record = self.last_record(bench)
        self.assertEqual(record["result"]["to"], self.firmware)
        self.assertEqual(record["result"]["sha256"], self.digest)

        self.assertTrue(self.run_it(bench), (bench.out / "results.jsonl").read_text())
        self.assertEqual(self.last_record(bench)["result"]["trial_job"], "job-real")

    def test_a_short_network_name_does_not_ruin_the_record_of_an_update(self):
        bench = self.failure_after_the_restart()
        (bench.out / "results.jsonl").unlink()
        bench.offer = lambda data, name: ("job-real", ota_bench.image_version(data))
        bench.wait_offered = lambda job: None
        bench.press = lambda button: None
        bench.wait_job = lambda job, timeout, follow=None: {"status": "SUCCEEDED"}
        bench.network_names = {self.digest[4:8], self.firmware[:3]}
        self.assertTrue(ota_bench.run(bench, "update", ota_bench.Bench.update, self.image))
        record = self.last_record(bench)
        self.assertEqual(record["result"]["sha256"], self.digest)
        self.assertEqual(record["result"]["to"], self.firmware)
        bench.trial_behind(self.firmware, self.digest)

    def test_a_board_on_another_image_is_not_touched(self):
        self.shortened()
        bench = self.bench_for()
        self.image.write_bytes(self.image.read_bytes()[:20] + bytes([99]) + self.image.read_bytes()[21:])
        data = self.image.read_bytes()
        self.trial_on_record(bench, digest=ota_bench.hashlib.sha256(data).hexdigest(),
                             to=ota_bench.image_version(data))
        self.assertFalse(self.run_it(bench))
        record = self.last_record(bench)
        self.assertEqual(record["outcome"], "NOT_RUN")
        self.assertIn("the board runs", record["error"])
        self.assertNotIn(b"TEST_WIFI_DEAD\r", b"".join(bench.commands))

    def test_a_count_that_is_not_0_is_not_touched(self):
        self.shortened()
        bench = self.bench_for()
        self.trial_on_record(bench)
        real_status = bench.console.status
        bench.console.status = lambda: real_status() | {"stuck count": "2"}
        self.assertFalse(self.run_it(bench))
        record = self.last_record(bench)
        self.assertEqual(record["outcome"], "NOT_RUN")
        self.assertIn("stuck count", record["error"])

    def test_a_network_name_does_not_get_into_the_results(self):
        bench = self.bench_for()
        name = "Tester\u2019s iPhone"
        bench.console.status = lambda: {"thing name": "x", "wifi network": name, "cloud": "not connected",
                                        "wifi link": "down", "update": "idle (last: none)",
                                        "firmware": "1", "endpoint": "secret-ats.example.com",
                                        "download from": "https://secret.example.com/"}

        def waits(bench_self, path):
            bench_self.wait_status("the moon", lambda s: False, 0.05)

        self.assertFalse(ota_bench.run(bench, "x", waits, self.image))
        text = (bench.out / "results.jsonl").read_text()
        self.assertIn("the moon", text)
        for word in ("iPhone", "u2019", "secret"):
            self.assertNotIn(word, text)
        self.assertIn("wifi link", text)

        # Whatever else carries the name, once the bench knows it.
        def says_it(bench_self, path):
            raise TestFailedError(f"a message about {name}")

        self.assertFalse(ota_bench.run(bench, "x", says_it, self.image))
        text = (bench.out / "results.jsonl").read_text()
        self.assertIn("a message about <network>", text)
        self.assertNotIn("iPhone", text)

    def test_what_names_the_account_does_not_get_into_the_results(self):
        bench = self.bench_for()
        bench.thing = "cranium-thething"
        bench.account_names = {"the-bucket-name"}
        arns = ["arn:aws:sts::123456789012:assumed-role/the-role/session",
                "arn:aws:iot:us-east-1:123456789012:thing/cranium-thething"]

        def says_it(bench_self, path):
            raise TestFailedError(f"get-thing-shadow: not allowed for {arns[0]} on {arns[1]} "
                                  "of cranium-thething in the-bucket-name, account 123456789012")

        self.assertFalse(ota_bench.run(bench, "x", says_it, self.image))
        text = (bench.out / "results.jsonl").read_text()
        for word in ("arn:", "123456789012", "the-role", "thething", "the-bucket-name"):
            self.assertNotIn(word, text)
        self.assertIn("not allowed for <account> on <account>", text)

        # In a result too, as in the lines of the boot log that a scenario can hand back.
        def returns_it(bench_self, path):
            return {"bootloader": [f"from {arns[1]}"], "to": "1.6.9+0"}

        self.assertTrue(ota_bench.run(bench, "x", returns_it, self.image))
        record = self.last_record(bench)
        self.assertEqual(record["result"], {"bootloader": ["from <account>"], "to": "1.6.9+0"})

    def test_a_hang_on_record_says_why_the_firmware_may_still_have_been_waiting(self):
        bench = self.bench_for()

        def hangs(bench_self, path):
            bench_self.watch.feed("[x] ERR: hal_rpu_ready_wait: Timed out waiting")
            with mock.patch.object(ota_bench, "HANG_PATIENCE_SECONDS", 0):
                bench_self.wait_status("a join", lambda s: False, 600)

        self.assertFalse(ota_bench.run(bench, "x", hangs, self.image))
        error = self.last_record(bench)["error"]
        self.assertIn("the bench has stopped waiting", error)
        self.assertIn("stuck count 0", error)
        self.assertIn("update idle", error)

    def test_a_hang_in_a_wait_ends_the_scenario_and_is_on_record(self):
        bench = self.bench_for()

        def hangs(bench_self, path):
            bench_self.watch.feed("[x] ERR: hal_rpu_ready_wait: Timed out waiting")
            with mock.patch.object(ota_bench, "HANG_PATIENCE_SECONDS", 0):
                bench_self.wait_status("a join", lambda s: False, 600)

        started = time.time()
        self.assertFalse(ota_bench.run(bench, "x", hangs, self.image))
        self.assertLess(time.time() - started, 10)
        self.assertTrue(self.last_record(bench)["chip_stuck"])
        self.assertTrue(bench.chip_stuck)
        self.assertIn(b"REBOOT\r", b"".join(bench.commands))

    def test_chip_dead_is_in_the_scenarios_and_takes_one_image(self):
        self.assertIs(ota_bench.SCENARIOS["chip-dead"], ota_bench.Bench.chip_dead)
        result = subprocess.run([sys.executable, str(Path(ota_bench.__file__)), "chip-dead", "a", "b"],
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("one image", result.stderr)


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
