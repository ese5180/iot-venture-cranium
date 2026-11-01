#!/usr/bin/env python3
"""Hardware checks of the serial console: the seven checks of its specification and the
rest of its commands, on a real board.

    python3 firmware/tests/hil/console_bench.py plan              show what it would do; touches nothing
    python3 firmware/tests/hil/console_bench.py run --no-erase    only the steps that erase nothing
    python3 firmware/tests/hil/console_bench.py run --erase       all of it, and provision the board again
    python3 firmware/tests/hil/console_bench.py run --erase --only check-6-power-loss
    python3 firmware/tests/hil/console_bench.py restore           only provision the board again

Nothing runs unless it is told to: without `run` this prints the plan and leaves the board
alone, and `run` wants to hear whether it may erase.

The Wi-Fi network comes from ~/.cranium/wifi_secrets.h, as in tools/provision_device.py,
and neither the network nor its password is printed. Everything both serial ports print
goes to --out, with the password taken out. Each step ends with PASS or FAIL and appends
one line to results.jsonl there, in the same form as ota_bench.py. Neither that file nor what
this prints holds the network's name, or what names the AWS account.

A step that erases the board is followed by restoring it with tools/provision_device.py
--profile <profile>, which provisions it again unattended: it needs that script's AWS
profile, cloud/.deploy/outputs.json, and a Wi-Fi secrets file that can be read without sudo
(python tools/secrets.py wifi --unlocked replaces a locked one). `run --erase` checks all of
that before it does anything. Stopped with Ctrl-C it restores nothing, says what state the
board is in, and leaves that in --out, where the `restore` command finds it.

What cannot be checked from here: what LED1 shows in factory mode. The plan says when to
look at it.

Run from an nRF Connect SDK terminal for pyserial, cbor2 and nrfutil.
"""

import argparse
import base64
import dataclasses
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

from board import (BoardError, Console, FINAL_LINE, ShellFirmware, crc16_ccitt_false,  # noqa: E402
                   find_console_port, parse_key_values)
from local import WIFI_SECRETS  # noqa: E402
from ota_bench import (ACCOUNT_SHOWN, STUCK_RESTART, Aws, ChipStuck, LoggedPort,  # noqa: E402
                       TestFailed, WifiWatch, account_names_in, hang_context, image_version,
                       judge_stuck_during_join, note, scrub)
from provision_device import OUTPUTS, read_wifi_secrets  # noqa: E402
from serial.tools import list_ports  # noqa: E402

BOOT_STATE = re.compile(r"^\[BOOT\] \| State\s+(\S+)")
WIFI_CONNECTED = re.compile(r"^\[WIFI\] connected ip=(\S+) rssi=(-?\d+)")
WIFI_FAILED = re.compile(r"^\[WIFI\] failed reason=(.+)")
WIFI_DISCONNECTED = re.compile(r"^\[WIFI\] disconnected")
# What a board says that does not show that a password was ever tried. A hotspot that has not
# been seen yet gives these before the password matters.
NOT_ABOUT_THE_PASSWORD = ("network not found", "request refused", "no answer")
ANY_TAGGED_LINE = re.compile(r"^\[[\w.-]+\] ")
# A log line, with the name of a module, as opposed to [BOOT], [WIFI] or [CONSOLE].
MODULE_LOG_LINE = re.compile(r"^\[([a-z][\w.-]*)\] ")
FIRMWARE_LOG_LINE = re.compile(r"^\[app\] Cranium firmware \S+$")
FACTORY_LOG_LINE = re.compile(r"^\[app\] WRN: Factory mode")
HELP_FIRST_LINE = "Cranium console, firmware"
HELP_COMMANDS = ("HELP", "INIT", "GET_ID", "THING", "ECHO", "REBOOT", "ENTER_BOOTLOADER", "SET_ID",
                 "RESET_CONFIG", "FACTORY_RESET", "WIFI", "WIFI_SEC", "CLEAR_WIFI", "NET", "CLOUD",
                 "KEYGEN", "STATS", "STATUS", "STREAM_START", "STREAM_CHUNK", "STREAM_STATUS",
                 "STREAM_CANCEL", "BUTTON")
FACTORY_REFUSAL = "ERR factory mode, send INIT|<id> first"
ID_RULE = "ERR id must be 1-32 letters or digits"
NORMAL_ONLY = ("SET_ID|X1", "WIFI|a|b", "WIFI_SEC|a|WPA2_PSK|b", "CLEAR_WIFI", "NET", "STATS",
               "STATUS", "RESET_CONFIG", "FACTORY_RESET", "CLOUD|", "KEYGEN", "BUTTON|1",
               "STREAM_START|100|1|0|CA", "STREAM_STATUS", "STREAM_CANCEL")
STATUS_KEYS = ("state", "id", "thing name", "firmware", "wifi network", "wifi password",
               "wifi link", "wifi address", "endpoint", "download from", "cloud", "root CA",
               "private key", "certificate", "update")
# What a bad INIT must leave as it is. The rest of a status listing can change by itself.
STORED_KEYS = ("state", "id", "thing name", "firmware", "wifi network", "wifi password",
               "endpoint", "download from", "root CA", "private key", "certificate")
REDACTED = "<secret>"
BOOT_SECONDS = 30
UPLOAD_SECONDS = 600
# Long enough for the board's retries of a join (30 s) to show if it were making any.
OFF_THE_NETWORK_SECONDS = 40
LOG_WATCH_SECONDS = 12
NETWORK_ATTEMPTS = 2
# TF-M's internal trusted storage, NV counters and protected storage: see the device tree.
TFM_STORAGE_START = 0xf4000
TFM_STORAGE_SIZE = 48 * 1024
DEFAULT_PROBE = "001050797470"

# What this bench has done to the board and not undone yet. Kept in a file in --out, because
# a run can end at any moment, and the two images cannot be told apart from their version.
UNDONE_FILE = "undone.json"
ERASED = "the board has been erased and is not provisioned"
FAULT_IMAGE = "the test image that loses power during INIT is installed"
RELEASE_IMAGE = "the release image is installed, which has no console"
WRONG_NETWORK = "the board does not hold the right Wi-Fi network"


def load_undone(out: Path) -> set[str]:
    try:
        return set(json.loads((out / UNDONE_FILE).read_text()))
    except (OSError, ValueError):
        return set()


def strange_lines(lines: list[str]) -> list[str]:
    """What is neither a final line, nor tagged, nor the echo of the tools' first command, in
    a stretch without multi-line replies. A reset can put a stray byte in front of a line."""
    cleaned = [line.strip("\x00\ufffd") for line in lines]
    return [line for line in cleaned
            if line not in "ECHO|OFF" and not FINAL_LINE.match(line)
            and not ANY_TAGGED_LINE.match(line)]


def commands_missing_from_help(lines: list[str]) -> list[str]:
    """The commands that have no row in a reply to HELP. What comes in here has lost its leading
    blanks, so a row is the name of its command, behind the mark if it has one."""
    rows = {line.removeprefix("* ").split()[0] for line in lines if line.strip()}
    return [name for name in HELP_COMMANDS if name not in rows]


def log_lines_around_help(lines: list[str]) -> tuple[list[str], int]:
    """The tagged lines inside a reply to HELP, which must not exist, and how many there were
    between two replies, which shows that some were waiting while a reply went out."""
    inside = []
    between = waiting = 0
    in_reply = seen_reply = False
    for line in lines:
        if line.startswith(HELP_FIRST_LINE):
            in_reply = seen_reply = True
            between += waiting
            waiting = 0
        elif ANY_TAGGED_LINE.match(line):
            if in_reply:
                inside.append(line)
            elif seen_reply:
                waiting += 1
        elif FINAL_LINE.match(line):
            in_reply = False
    return inside, between


def erased_flash_hex(start: int, size: int) -> str:
    """Intel HEX of erased flash, for nrfutil to erase exactly the pages it touches."""
    def record(kind: int, address: int, data: bytes) -> str:
        body = bytes([len(data), address >> 8, address & 0xff, kind]) + data
        return f":{body.hex().upper()}{-sum(body) & 0xff:02X}"

    lines = []
    upper = None
    for offset in range(start, start + size, 32):
        if offset >> 16 != upper:
            upper = offset >> 16
            lines.append(record(4, 0, upper.to_bytes(2, "big")))
        lines.append(record(0, offset & 0xffff, b"\xff" * 32))
    lines.append(record(1, 0, b""))
    return "\n".join(lines) + "\n"


class NotApplicable(Exception):
    """This step has nothing to do on this board. It neither passes nor fails."""


@dataclasses.dataclass
class Step:
    name: str
    what: str
    function: Callable
    erases: bool = False


class ConsoleBench:
    def __init__(self, args):
        self.args = args
        self.out = Path(args.out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.lines = []
        # When each of those came. It is added to first, so it is never the shorter one.
        self.line_times = []
        self.secret_values = []
        self.credentials = None
        self.watch = WifiWatch()
        self.device = args.port or find_console_port()
        self.boot_device = args.boot_port or self._other_port()
        self.boot = None
        self.link = None
        self.console = None
        self.undone = load_undone(self.out)
        self.results = []
        self.open_ports()

    def _other_port(self) -> str | None:
        if self.args.port:
            return None
        ports = sorted(p.device for p in list_ports.comports()
                       if p.vid == 0x1366 and "usbmodem" in p.device.lower())
        return next((p for p in ports if p != self.device), None)

    def open_ports(self) -> None:
        if self.boot_device:
            self.boot = LoggedPort(self.boot_device, self.out / "vcom0-boot.log")
        self.link = LoggedPort(self.device, self.out / "vcom1-app.log", self.on_line,
                               self.redact)
        self.console = Console(self.device, self.link)

    def close_ports(self) -> None:
        if self.link:
            self.link.close()
        if self.boot:
            self.boot.close()
        self.link = self.boot = self.console = None

    # ---- what has been done to the board ----------------------------------------------

    def remember(self, what: str) -> None:
        self.undone.add(what)
        self._save_undone()

    def forget(self, what: str) -> None:
        self.undone.discard(what)
        self._save_undone()

    def _save_undone(self) -> None:
        (self.out / UNDONE_FILE).write_text(json.dumps(sorted(self.undone)))

    # ---- what the board says about its Wi-Fi chip -------------------------------------

    def on_line(self, line: str) -> None:
        self.line_times.append(time.time())
        self.lines.append(line)
        self.watch.feed(line)

    def status_or_nothing(self) -> dict | None:
        try:
            return self.console.status()
        except BoardError:
            return None

    def rescue_from_hang(self) -> None:
        """A hung chip stays hung until a restart. Nothing after this could join a network."""
        note("the Wi-Fi chip has stopped answering and the board has not restarted: restarting it")
        try:
            self.console.exchange("REBOOT")
            self.console.wait_until_up(BOOT_SECONDS)
        except BoardError as error:
            note(f"restarting it: {error}")
        self.watch.clear()

    # ---- what is known about the network ---------------------------------------------

    def redact(self, text: str) -> str:
        for value in self.secret_values:
            text = text.replace(value, REDACTED)
        return text

    def network(self) -> tuple[str, str, str]:
        """The network to use. Read once, and never printed."""
        if self.credentials is None:
            self.credentials = read_wifi_secrets()
            self.secret_values.append(self.credentials[1])
        return self.credentials

    def safe_for_results(self, value):
        """What goes into results.jsonl and on the screen: no password, not the network's name,
        which the logs hold and which a result that gets quoted should not, and no name of the
        account's."""
        names = [self.credentials[0]] if self.credentials else []
        value = scrub(value, self.secret_values, REDACTED)
        return scrub(scrub(value, account_names_in(OUTPUTS), ACCOUNT_SHOWN), names)

    def wifi_command(self, password: str | None = None) -> str:
        ssid, right_password, security = self.network()
        password = right_password if password is None else password
        if security == "WPA2_PSK":
            return f"WIFI|{ssid}|{password}"
        return f"WIFI_SEC|{ssid}|{security}|{password}"

    # ---- talking to the board --------------------------------------------------------

    def mark(self) -> int:
        return len(self.lines)

    def mark_after_the_last_reply(self) -> int:
        """A line reaches board.Console a moment before it gets into self.lines. For when what
        comes after the mark matters line by line."""
        time.sleep(0.2)
        return self.mark()

    def wait_line(self, pattern: re.Pattern, timeout: float, since: int) -> re.Match:
        """Wait for a line from the board, also one that arrived since the mark was taken."""
        deadline = time.time() + timeout
        position = since
        while True:
            for line in self.lines[position:]:
                position += 1
                match = pattern.search(line)
                if match:
                    return match
            self.watch.check()
            if time.time() > deadline:
                raise TestFailed(f"no line like {pattern.pattern} within {timeout:.0f} s")
            time.sleep(0.05)

    def seen_since(self, pattern: re.Pattern, since: int) -> list[str]:
        return [line for line in self.lines[since:] if pattern.search(line)]

    def no_secret_came_back(self, since: int) -> None:
        """A password in a line from the board has been replaced in self.lines, as in the log."""
        if any(REDACTED in line for line in self.lines[since:]):
            raise TestFailed("a line from the board held a password")

    def final(self, command: str, wait: float = 3.0) -> str:
        return self.console.exchange(command, wait)[1]

    def expect_final(self, command: str, expected: str, wait: float = 3.0) -> None:
        final = self.final(command, wait)
        if final != expected:
            raise TestFailed(f"{command.split('|')[0]} answered \"{self.redact(final)}\", "
                             f"expected \"{expected}\"")

    def expect_final_like(self, command: str, pattern: str, wait: float = 3.0) -> str:
        final = self.final(command, wait)
        if not re.fullmatch(pattern, final):
            raise TestFailed(f"{command.split('|')[0]} answered \"{self.redact(final)}\", "
                             f"expected something like \"{pattern}\"")
        return final

    def raw_final(self, data: bytes, wait: float = 3.0) -> str:
        """Send bytes as a terminal would, and return the final line that comes back."""
        self.console.handshake()
        self.link.write(data)
        for line in self.console.lines(time.time() + wait):
            if FINAL_LINE.match(line):
                return line
        raise TestFailed(f"no final line in reply to {data[:30]!r}")

    def no_final_for(self, seconds: float) -> None:
        for line in self.console.lines(time.time() + seconds):
            if FINAL_LINE.match(line):
                raise TestFailed(f"one more final line came: {self.redact(line)}")

    def wait_for_boot(self, since: int, state: str) -> None:
        found = self.wait_line(BOOT_STATE, BOOT_SECONDS, since).group(1)
        if found != state:
            raise TestFailed(f"the board restarted as {found}, expected {state}")
        self.console.wait_until_up(BOOT_SECONDS)

    def reboot_and_wait(self, state: str) -> int:
        mark = self.mark()
        self.expect_final("REBOOT", "OK rebooting")
        self.wait_for_boot(mark, state)
        return mark

    def wait_connected(self, since: int) -> re.Match:
        """A phone's hotspot can take minutes to be seen, and failures come before it is."""
        connected = self.wait_line(WIFI_CONNECTED, self.args.join_timeout, since)
        if connected.group(1) == "none":
            raise TestFailed("the board says it connected, without an address")
        return connected

    def store_right_network(self) -> None:
        # The board may just be restarting: that is one way of ending up here.
        self.console.wait_until_up(BOOT_SECONDS)
        final = self.console.exchange(self.wifi_command(), 8)[1]
        if not final.startswith("OK saved, connecting to "):
            raise TestFailed(f"the right network was not taken: {self.redact(final)}")
        self.forget(WRONG_NETWORK)

    def join_right_network(self) -> re.Match:
        mark = self.mark()
        self.store_right_network()
        return self.wait_connected(mark)

    def put_network_back(self) -> re.Match | None:
        """The [WIFI] line of the right network, or None. It raises nothing, because a failure
        here must not hide why the step failed. If the wrong one stays, main() tries again."""
        for _ in range(NETWORK_ATTEMPTS):
            try:
                return self.join_right_network()
            except ChipStuck as error:
                note(f"putting the right network back: {error}")
                self.rescue_from_hang()
                continue
            except (TestFailed, BoardError, OSError) as error:
                note(f"putting the right network back: {self.safe_for_results(str(error))}")
            if WRONG_NETWORK not in self.undone:
                break
        return None

    def network_back(self) -> dict:
        if self.put_network_back() is None:
            raise TestFailed("the right network could not be put back")
        return {"network": "put back"}

    def recover(self, *arguments: str) -> None:
        """Run tools/recover.py, which wants the port for itself."""
        device = self.device
        self.close_ports()
        try:
            result = subprocess.run([sys.executable, str(REPO / "tools" / "recover.py"),
                                     "--port", device, *arguments],
                                    capture_output=True, text=True, timeout=UPLOAD_SECONDS)
            with open(self.out / "recover.log", "a") as file:
                file.write(result.stdout + result.stderr)
            if result.returncode != 0:
                raise TestFailed(f"recover.py {arguments[0]}: {result.stderr.strip()[-300:]}")
        finally:
            self.open_ports()

    def upload(self, image: Path, *entry: str) -> None:
        if not image.exists():
            raise TestFailed(f"{image} does not exist: build it first (see the plan)")
        note(f"installing {image.name} through the bootloader; this takes about four minutes")
        self.recover(*entry, "upload", str(image))

    def install(self, image: Path, *entry: str) -> None:
        self.upload(image, *entry)
        self.console.wait_until_up(60)

    def leave_bootloader(self) -> None:
        """The bootloader stays until it is told to go, and everything after it depends on that.
        A failure here raises nothing: the board then not coming back says enough."""
        try:
            self.recover("reset")
        except TestFailed as error:
            note(f"leaving the bootloader: {error}")

    def nrfutil(self, *arguments: str) -> None:
        result = subprocess.run(["nrfutil", "device", *arguments,
                                 "--serial-number", self.args.serial_number],
                                capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise TestFailed(f"nrfutil {arguments[0]}: {result.stderr.strip()[-300:]}")

    def reported_uptime(self, thing: str) -> int | None:
        """What the board last told the cloud. Nothing else shows that a release image runs."""
        region = json.loads(OUTPUTS.read_text())["Region"]
        path = self.out / "shadow.json"
        result = subprocess.run(Aws(self.args.profile, region).base
                                + ["iot-data", "get-thing-shadow", "--thing-name", thing, str(path)],
                                capture_output=True, text=True)
        if result.returncode != 0:
            raise TestFailed(f"get-thing-shadow: {result.stderr.strip()[:300]}")
        return json.loads(path.read_text())["state"]["reported"].get("uptime")

    # ---- the steps -------------------------------------------------------------------

    def migration(self) -> dict:
        """A board with firmware from before the console is updated over the air: it must
        not end up in factory mode, and the trial image must confirm itself."""
        try:
            self.console.handshake()
        except ShellFirmware:
            pass
        else:
            raise NotApplicable("the board already runs the console: its migration is behind it")

        image = Path(self.args.image)
        if not image.exists():
            raise TestFailed(f"{image} does not exist: build it first (see the plan)")

        device = self.device
        self.close_ports()
        log = self.out / "migration"
        try:
            note("updating over the air from the firmware with the shell; this takes minutes")
            environment = dict(os.environ, AWS_PROFILE=self.args.profile)
            result = subprocess.run([sys.executable, str(REPO / "firmware/tests/hil/ota_bench.py"),
                                     "update", str(image), "--via", "direct", "--out", str(log)],
                                    env=environment, text=True, capture_output=True)
            (self.out / "migration.log").write_text(result.stdout + result.stderr)
            if result.returncode != 0:
                raise TestFailed(f"the update failed, see {self.out / 'migration.log'}")
        finally:
            self.open_ports()

        app_log = (log / "vcom1-app.log").read_text(errors="replace")
        if "[CONSOLE] migrated" not in app_log:
            raise TestFailed("the log does not show the migration")

        status = self.console.status()
        device_id, firmware = self.console.get_id()
        if not re.fullmatch(r"[0-9a-f]{16}", device_id):
            raise TestFailed(f"the ID is {device_id}, expected the SoC's 16 hexadecimal digits")
        if status["thing name"] != f"cranium-{device_id}":
            raise TestFailed(f"the thing name changed: {status['thing name']}")
        if status["state"] != "OPERATING" or status["cloud"] != "connected":
            raise TestFailed(f"after the update: {status['state']}, cloud {status['cloud']}")
        if firmware != image_version(image.read_bytes()):
            raise TestFailed(f"running {firmware} after the update")
        if not status["update"].startswith("idle"):
            raise TestFailed(f"the trial did not end: update {status['update']}")
        return {"id": device_id, "firmware": firmware}

    def protocol(self) -> dict:
        """The line protocol, and the commands that only read."""
        ok_id = r"OK [0-9A-Za-z]*\|\S+"

        # Each line ending, and each counts once.
        for ending in (b"\r", b"\n", b"\r\n"):
            if not re.fullmatch(ok_id, self.raw_final(b"GET_ID" + ending)):
                raise TestFailed(f"GET_ID with line ending {ending!r} failed")
            self.no_final_for(0.3)

        # Blank lines give no reply at all, and leading whitespace does not matter.
        self.console.handshake()
        self.link.write(b"\r\n\r\n   \r\t\n")
        self.no_final_for(0.5)
        if not re.fullmatch(ok_id, self.raw_final(b"  \t GET_ID\r")):
            raise TestFailed("leading whitespace was not ignored")

        # Command names in any case.
        if not re.fullmatch(ok_id, self.raw_final(b"gEt_iD\r")):
            raise TestFailed("the command name was not taken in lower case")

        # Too long for the buffer: discarded whole, and the next line works.
        final = self.raw_final(b"X" * 500 + b"\r")
        if not final.startswith("ERR line too long"):
            raise TestFailed(f"an overlong line got: {final}")
        if not re.fullmatch(ok_id, self.raw_final(b"GET_ID\r")):
            raise TestFailed("the line after an overlong one did not work")

        # Backspace and DEL, also on an empty line.
        for keys in (b"GET_IX\x08D\r", b"GET_IX\x7fD\r", b"\x08\x7f\x08GET_ID\r"):
            if not re.fullmatch(ok_id, self.raw_final(keys)):
                raise TestFailed(f"{keys!r} did not end up as GET_ID")

        # Errors.
        self.expect_final("FOO|not-for-your-eyes", "ERR unknown command FOO, type HELP")
        self.expect_final("SET_ID", "ERR usage: SET_ID|<id>")
        self.expect_final("GET_ID|x", "ERR usage: GET_ID")
        self.expect_final("WIFI|net", "ERR usage: WIFI|<ssid>|<password>")

        # Echo: on for a terminal, off for a script.
        self.console.handshake()
        self.expect_final("ECHO|ON", "OK echo on")
        self.link.write(b"GET_ID\r")
        echoed = False
        finished = False
        for line in self.console.lines(time.time() + 3):
            echoed = echoed or line == "GET_ID"
            if FINAL_LINE.match(line):
                finished = True
                break
        if not (echoed and finished):
            raise TestFailed("with echo on, GET_ID did not come back and get a reply")
        self.expect_final("ECHO|OFF", "OK echo off")

        # HELP is a table of every command, grouped, with the version.
        reply, final = self.console.exchange("HELP")
        text = "\n".join(reply)
        firmware = self.console.get_id()[1]
        if final != "OK" or firmware not in text:
            raise TestFailed("HELP is not complete")
        missing = commands_missing_from_help(reply)
        if missing:
            raise TestFailed(f"HELP does not list {missing}")
        if self.console.exchange("?") != (reply, final):
            raise TestFailed("? is not the same as HELP")
        if self.console.exchange("help") != (reply, final):
            raise TestFailed("help in small letters is not the same as HELP")

        # Status commands, which never show a secret.
        status = self.console.status()
        missing = [key for key in STATUS_KEYS if key not in status]
        if missing:
            raise TestFailed(f"STATUS does not show {missing}")
        for section, key in (("device", "thing name"), ("wifi", "wifi link"), ("cloud", "endpoint"),
                             ("certs", "private key"), ("update", "update")):
            values = parse_key_values(self.console.run(f"STATUS|{section}"))
            if key not in values or "state" in values and section != "device":
                raise TestFailed(f"STATUS|{section} shows {sorted(values)}")
        self.expect_final_like("STATUS|nonsense", "ERR unknown section.*")

        net = parse_key_values(self.console.run("NET"))
        for key in ("state", "ssid", "ip", "rssi", "mac"):
            if key not in net:
                raise TestFailed(f"NET does not show {key}")

        stats = "\n".join(self.console.run("STATS"))
        for word in ("State", "ID", "Firmware", "WiFi", "Uptime", "Free heap", "Reset"):
            if word not in stats:
                raise TestFailed(f"STATS does not show {word}")

        return {"status_keys": len(status), "reset": re.search(r"Reset\s+(.*?)\s*\|", stats)[1]}

    def log_lines(self) -> dict:
        """Everything from a boot on is a reply, a line of the status box or a tagged line, log
        lines carry their module's name, and none ever lands inside a reply."""
        state = self.console.status()["state"]
        self.mark_after_the_last_reply()
        mark = self.reboot_and_wait(state)
        self.wait_line(FIRMWARE_LOG_LINE, BOOT_SECONDS, mark)
        time.sleep(LOG_WATCH_SECONDS)
        self.console.handshake()
        self.mark_after_the_last_reply()

        lines = list(self.lines[mark:])
        strange = strange_lines(lines)
        if strange:
            raise TestFailed(f"lines that are neither a reply nor tagged: {strange[:5]}")
        modules = sorted({match[1] for match in map(MODULE_LOG_LINE.match, lines) if match})

        # Saving the cloud settings again makes the board reconnect, and it logs all of that,
        # from other threads, while replies go out.
        status = self.console.status()
        endpoint, prefix = status.get("endpoint", "unset"), status.get("download from", "unset")
        if endpoint == "unset":
            raise TestFailed("this step needs a board with cloud settings")
        mark = self.mark_after_the_last_reply()
        self.expect_final(f"CLOUD|{endpoint}|{prefix}", "OK cloud settings saved", 6)
        deadline = time.time() + LOG_WATCH_SECONDS
        while time.time() < deadline:
            self.console.handshake()
            self.link.write(b"HELP\rHELP\rHELP\r")
            finals = 0
            for line in self.console.lines(time.time() + 8):
                finals += bool(FINAL_LINE.match(line))
                if finals == 3:
                    break

        self.mark_after_the_last_reply()
        inside, between = log_lines_around_help(self.lines[mark:])
        if inside:
            raise TestFailed(f"log lines inside a reply: {inside[:5]}")
        if not between:
            raise TestFailed("no log line came while the replies went out, so this shows "
                             "nothing: run it again")
        return {"modules": modules, "log_lines_between_replies": between}

    def boot_input(self) -> dict:
        """What is sent while the board boots is thrown away. A command right after it works,
        without the line ending in front of it that the tools always send."""
        state = self.console.status()["state"]

        # How long a boot takes, so that what is sent next arrives before the status box.
        mark = self.mark()
        self.expect_final("REBOOT", "OK rebooting")
        started = time.time()
        self.wait_line(BOOT_STATE, BOOT_SECONDS, mark)
        boot_seconds = time.time() - started
        self.console.wait_until_up(BOOT_SECONDS)

        self.expect_final("REBOOT", "OK rebooting")
        started = time.time()
        mark = self.mark_after_the_last_reply()
        # A whole command, whose reply would show, and then text with no line ending.
        while time.time() - started < boot_seconds * 0.4:
            self.link.write(b"ECHO|OFF\r")
            time.sleep(0.05)
        while time.time() - started < boot_seconds * 0.7:
            self.link.write(b"abc")
            time.sleep(0.05)
        if self.wait_line(BOOT_STATE, BOOT_SECONDS, mark).group(1) != state:
            raise TestFailed("the board came back in another state")
        time.sleep(1)

        answered = self.mark()
        self.link.write(b"GET_ID\r")
        self.wait_line(FINAL_LINE, 3, answered)
        self.mark_after_the_last_reply()
        lines = self.lines[answered:]
        final = next(line for line in lines if FINAL_LINE.match(line))
        if not re.fullmatch(r"OK [0-9A-Za-z]*\|\S+", final):
            raise TestFailed(f"the first command after a boot got: {self.redact(final)}")
        if "GET_ID" not in lines:
            raise TestFailed("echo is off after a boot: a command sent during it was run")
        run_during_boot = self.seen_since(re.compile(r"^(ERR |OK echo off)"), mark)
        if run_during_boot:
            raise TestFailed(f"input from during the boot got replies: {run_during_boot[:3]}")
        return {"boot_seconds": round(boot_seconds, 1)}

    def check_2(self) -> dict:
        """INIT|bad id! returns ERR and erases nothing."""
        before = self.console.status()
        mark = self.mark()
        self.expect_final("INIT|bad id!", ID_RULE)
        time.sleep(2)
        after = self.console.status()
        changed = [key for key in STORED_KEYS if before.get(key) != after.get(key)]
        if changed:
            raise TestFailed(f"a refused INIT changed {changed}")
        if self.seen_since(BOOT_STATE, mark):
            raise TestFailed("a refused INIT restarted the board")
        return {"state": after["state"]}

    def check_4(self) -> dict:
        """WIFI reports the join result, and the board reconnects after REBOOT."""
        started = time.time()
        mark = self.mark()
        final = self.console.exchange(self.wifi_command(), 8)[1]
        answered = time.time() - started
        if not final.startswith("OK saved, connecting to "):
            raise TestFailed(f"WIFI answered: {self.redact(final)}")

        connected = self.wait_connected(mark)
        failures_first = len(self.seen_since(WIFI_FAILED, mark))
        net = parse_key_values(self.console.run("NET"))
        if net.get("state") != "connected" or net.get("ip") != connected.group(1):
            raise TestFailed(f"NET does not agree with the [WIFI] line: {net.get('state')}, "
                             f"{net.get('ip')}, not {connected.group(1)}")

        mark = self.reboot_and_wait(self.console.status()["state"])
        again = self.wait_connected(mark)
        return {"answered_in_seconds": round(answered, 2), "ip": connected.group(1),
                "rssi": int(connected.group(2)), "failures_before_joining": failures_first,
                "ip_after_reboot": again.group(1)}

    def check_5(self) -> dict:
        """A wrong password reports a failure, and the console keeps answering."""
        self.remember(WRONG_NETWORK)
        problem = None
        try:
            result = self.try_wrong_password()
        except Exception as error:  # noqa: BLE001  Whatever it was, the network goes back.
            problem = error

        connected = self.put_network_back()
        if problem:
            raise problem
        if connected is None:
            raise TestFailed("the right network could not be put back")
        return result | {"ip_with_right_password": connected.group(1)}

    def try_wrong_password(self) -> dict:
        wrong = "wrong-" + os.urandom(8).hex()
        self.secret_values.append(wrong)
        mark = self.mark()
        started = time.time()
        slowest = 0.0
        outages = 0
        final = self.console.exchange(self.wifi_command(wrong), 8)[1]
        if not final.startswith("OK saved, connecting to "):
            raise TestFailed(f"WIFI answered: {self.redact(final)}")

        def reasons() -> list[str]:
            return [WIFI_FAILED.search(line).group(1) for line in self.seen_since(WIFI_FAILED, mark)]

        def stuck_restarts() -> list[str]:
            return [STUCK_RESTART.match(line).group(1) for line in self.seen_since(STUCK_RESTART, mark)]

        # Check 4 has just shown that the network is there, so a failure that has nothing to
        # say about the password only means that it has not been tried yet. The chip has hung
        # here once: a restart for that is what firmware with the timers does, and then the
        # wrong password has to be reported all the same. The result says that it happened.
        deadline = time.time() + self.args.join_timeout
        while all(reason in NOT_ABOUT_THE_PASSWORD for reason in reasons()):
            self.watch.check()
            if time.time() > deadline:
                raise TestFailed(f"the password was never tried, the board only said: {reasons()}")
            asked = time.time()
            try:
                self.console.get_id()
                slowest = max(slowest, time.time() - asked)
            except BoardError:
                # The console has to keep answering, which is what this check is for. A board that
                # said why it went gets its boot, as any board does, and only that one.
                if outages >= len(stuck_restarts()):
                    raise
                outages += 1
                self.console.wait_until_up(BOOT_SECONDS)
            time.sleep(0.5)

        restarts = judge_stuck_during_join(list(zip(self.line_times[mark:], self.lines[mark:])),
                                           started)

        if self.seen_since(WIFI_CONNECTED, mark):
            raise TestFailed("the board says it connected with a wrong password")

        status = self.console.status()
        if status["wifi link"] != "down":
            raise TestFailed(f"the link is {status['wifi link']} with a wrong password")
        return {"reasons": reasons(), "slowest_reply_seconds": round(slowest, 2),
                "stuck_restarts": restarts, "console_outages": outages}

    def settings_kept(self) -> dict:
        """SET_ID and CLEAR_WIFI on a board that is on the network: what they are for changes,
        nothing else does, and the board really leaves the network."""
        before = self.console.status()
        if before.get("wifi link") != "up":
            raise TestFailed(f"this step needs a board on the network: wifi link "
                             f"{before.get('wifi link')}")

        new_id = "KEPT" + before["id"][:8]
        try:
            self.expect_final(f"SET_ID|{new_id}", f"OK id set to {new_id}")
            after = self.console.status()
        finally:
            self.expect_final(f"SET_ID|{before['id']}", f"OK id set to {before['id']}")
        changed = [key for key in STORED_KEYS if key != "id" and before.get(key) != after.get(key)]
        if changed or after["id"] != new_id or after.get("wifi link") != "up":
            raise TestFailed(f"SET_ID changed {changed}, the id is {after['id']}, "
                             f"wifi link {after.get('wifi link')}")

        self.remember(WRONG_NETWORK)
        problem = None
        try:
            mark = self.mark()
            self.expect_final_like("CLEAR_WIFI", "OK network erased.*", 6)
            self.wait_line(WIFI_DISCONNECTED, 15, mark)
            after = self.console.status()
            if after["wifi network"] != "unset" or after["wifi password"] != "unset":
                raise TestFailed("CLEAR_WIFI left the network behind")
            if after["wifi link"] != "down":
                raise TestFailed(f"after CLEAR_WIFI the link is {after['wifi link']}")
            changed = [key for key in STORED_KEYS if not key.startswith("wifi ")
                       and before.get(key) != after.get(key)]
            if changed:
                raise TestFailed(f"CLEAR_WIFI also changed {changed}")
        except Exception as error:  # noqa: BLE001  Whatever it was, the network goes back.
            problem = error

        connected = self.put_network_back()
        if problem:
            raise problem
        if connected is None:
            raise TestFailed("the right network could not be put back")
        return {"id_kept": before["id"], "ip_again": connected.group(1)}

    def bootloader(self) -> dict:
        """ENTER_BOOTLOADER: tools/recover.py catches the half second with no debugger."""
        running = self.console.get_id()[1]
        state = self.console.status()["state"]
        try:
            self.recover("--console", "list")
            listing = (self.out / "recover.log").read_text().splitlines()[-1]
        finally:
            # If the list failed after the bootloader answered, it is still listening.
            mark = self.mark()
            self.leave_bootloader()
        self.wait_for_boot(mark, state)
        if self.console.get_id()[1] != running:
            raise TestFailed("the firmware changed")
        return {"bootloader_says": listing}

    def release_image(self) -> dict:
        """A build without the console has no output at all, and it must still boot. All it
        shows of itself is its next report to the cloud."""
        image = Path(self.args.release_image)
        if not image.exists():
            raise NotApplicable(f"{image} has not been built (see the plan)")

        # Its reports are the only way to tell, so the board has to be able to send them.
        self.back_online()
        thing = self.console.status()["thing name"]

        self.remember(RELEASE_IMAGE)
        try:
            self.upload(image, "--console")
            before = self.reported_uptime(thing)
            deadline = time.time() + self.args.join_timeout
            while True:
                uptime = self.reported_uptime(thing)
                if uptime != before:
                    break
                if time.time() > deadline:
                    raise TestFailed("the release image sent no report: it may not have booted")
                time.sleep(5)
        finally:
            # This one has no console to ask to restart: only the debug port is left.
            self.install(Path(self.args.image), "--reset", "--serial-number",
                         self.args.serial_number)
            self.forget(RELEASE_IMAGE)
        return {"uptime_reported_by_release_image": uptime}

    def check_7(self) -> dict:
        """FACTORY_RESET returns the board to factory mode."""
        self.remember(ERASED)
        mark = self.mark()
        self.expect_final("FACTORY_RESET", "OK erased, rebooting into factory mode", 15)
        self.wait_for_boot(mark, "FACTORY")
        status = self.console.status()
        if status["state"] != "FACTORY" or status["id"] != "":
            raise TestFailed(f"after FACTORY_RESET: state {status['state']}, id {status['id']}")
        return {"state": status["state"]}

    def check_1(self) -> dict:
        """A board after a factory reset boots into factory mode. GET_ID works, WIFI|a|b is
        refused, and it stays off the network."""
        self.remember(ERASED)
        if self.console.status()["state"] != "FACTORY":
            self.expect_final("FACTORY_RESET", "OK erased, rebooting into factory mode", 15)
            self.console.wait_until_up(BOOT_SECONDS)

        return self.factory_mode_holds(self.reboot_and_wait("FACTORY"))

    def check_1_erased_storage(self) -> dict:
        """The same with storage that has really been erased, as the specification has it:
        TF-M's storage partition, over the debug port, so with nothing left behind by the
        firmware. This is also what a board that was never set up has."""
        self.remember(ERASED)
        path = self.out / "erased-tfm-storage.hex"
        path.write_text(erased_flash_hex(TFM_STORAGE_START, TFM_STORAGE_SIZE))
        self.nrfutil("program", "--firmware", str(path), "--options",
                     "chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE", "--core", "Application")
        mark = self.mark()
        self.nrfutil("reset", "--reset-kind", "RESET_PIN")
        self.wait_for_boot(mark, "FACTORY")
        return self.factory_mode_holds(mark)

    def factory_mode_holds(self, mark: int) -> dict:
        self.wait_line(FACTORY_LOG_LINE, 5, mark)
        firmware = self.console.get_id()[1]
        self.expect_final("GET_ID", f"OK |{firmware}")
        self.expect_final("WIFI|a|b", FACTORY_REFUSAL)
        for command in NORMAL_ONLY:
            self.expect_final(command, FACTORY_REFUSAL)

        # What works there.
        self.expect_final("ECHO|OFF", "OK echo off")
        self.expect_final_like("THING", r"OK cranium-[0-9a-f]{16}")
        if not self.console.run("HELP"):
            raise TestFailed("HELP is empty in factory mode")

        # It must not try to join a network, and it keeps running: the watchdog would
        # end this, if the main loop had stopped.
        time.sleep(OFF_THE_NETWORK_SECONDS)
        if self.seen_since(WIFI_FAILED, mark) or self.seen_since(WIFI_CONNECTED, mark):
            raise TestFailed("a board in factory mode tried to join a network")
        self.expect_final("GET_ID", f"OK |{firmware}")
        return {"led1": "not checked here: it should give a long flash every two seconds"}

    def check_3(self) -> dict:
        """INIT|ABC123 restarts into normal operation, and GET_ID returns ABC123."""
        self.remember(ERASED)
        mark = self.mark()
        self.expect_final("INIT|ABC123", "OK initialised as ABC123, rebooting", 15)
        self.wait_for_boot(mark, "OPERATING")
        device_id, firmware = self.console.get_id()
        if device_id != "ABC123":
            raise TestFailed(f"GET_ID says {device_id}")
        self.expect_final("GET_ID", f"OK ABC123|{firmware}")
        return {"id": device_id}

    def settings(self) -> dict:
        """The commands that change something, on a board with nothing worth keeping."""
        self.remember(ERASED)
        self.expect_final("SET_ID|NEWNAME1", "OK id set to NEWNAME1")
        self.expect_final("SET_ID|bad id!", ID_RULE)
        self.expect_final("SET_ID|123456789012345678901234567890123", ID_RULE)
        self.expect_final_like("GET_ID", r"OK NEWNAME1\|\S+")

        # Validation of the network, which never stores anything refused.
        self.expect_final(f"WIFI|{'s' * 33}|12345678", "ERR ssid must be 1-32 bytes")
        self.expect_final("WIFI||12345678", "ERR ssid must be 1-32 bytes")
        self.expect_final("WIFI|net|1234567", "ERR password must be 8-63 characters")
        self.expect_final(f"WIFI|net|{'p' * 64}", "ERR password must be 8-63 characters")
        self.expect_final("WIFI|net|", "ERR open networks are not allowed")
        self.expect_final_like("WIFI_SEC|net|WEP|12345678", "ERR security must be.*")
        status = self.console.status()
        if status["wifi network"] != "unset" and status["wifi network"] == "net":
            raise TestFailed("a refused network was stored")

        # Cloud settings: validate, save, clear.
        endpoint, prefix = "example-ats.iot.us-east-1.amazonaws.com", "https://b.example.com/fw/"
        self.expect_final(f"CLOUD|{endpoint}|{prefix}", "OK cloud settings saved", 6)
        if self.console.status()["endpoint"] != endpoint:
            raise TestFailed("the endpoint was not stored")
        self.expect_final_like(f"CLOUD|{endpoint}|http://b.example.com/fw/", "ERR endpoint must.*")
        self.expect_final(f"CLOUD|{endpoint}", "ERR usage: CLOUD|<endpoint>|<download-url-prefix>")
        self.expect_final("CLOUD|", "OK cloud settings cleared", 6)
        if self.console.status()["endpoint"] != "unset":
            raise TestFailed("the endpoint was not cleared")

        # RESET_CONFIG clears the cloud settings and nothing else.
        self.expect_final(f"CLOUD|{endpoint}|{prefix}", "OK cloud settings saved", 6)
        self.expect_final_like("RESET_CONFIG", "OK cloud settings cleared.*", 6)
        status = self.console.status()
        if status["endpoint"] != "unset" or status["id"] != "NEWNAME1":
            raise TestFailed("RESET_CONFIG did the wrong thing")

        # The key: created here, and only a request for it comes out.
        reply = self.console.run("KEYGEN", 30)
        text = "\n".join(reply)
        if "BEGIN CERTIFICATE REQUEST" not in text or "PRIVATE" in text:
            raise TestFailed("KEYGEN did not print just a certificate request")
        if self.console.status()["private key"] != "set":
            raise TestFailed("the key was not stored")
        self.expect_final_like("KEYGEN", "ERR a device key exists.*", 5)
        if "BEGIN CERTIFICATE REQUEST" not in "\n".join(self.console.run("KEYGEN|REPLACE", 30)):
            raise TestFailed("KEYGEN|REPLACE did not print a request")

        # Streams, without storing anything.
        der = b"\x30" + bytes(range(99))
        chunk = base64.b64encode(der).decode()
        crc = crc16_ccitt_false(der)
        self.expect_final_like(f"STREAM_START|{len(der)}|1|{crc ^ 1:04x}|CERT", "OK ready.*")
        self.expect_final_like(f"STREAM_CHUNK|0|{chunk}", "ERR crc mismatch.*", 6)
        self.expect_final_like(f"STREAM_START|{len(der)}|2|{crc:04x}|CERT", "OK ready.*")
        self.expect_final_like(f"STREAM_CHUNK|1|{chunk}", "ERR wrong chunk index.*")
        self.expect_final("STREAM_STATUS", "OK idle")
        self.expect_final_like(f"STREAM_START|{len(der)}|1|{crc:04x}|CERT", "OK ready.*")
        self.expect_final_like("STREAM_STATUS", r"OK CERT chunk 0 of 1, .*")
        self.expect_final("STREAM_CANCEL", "OK transfer cancelled")
        if self.console.status()["certificate"] != "unset":
            raise TestFailed("a stream that failed left a certificate behind")

        # Giving up on a stream that has gone quiet.
        mark = self.mark()
        self.expect_final_like(f"STREAM_START|{len(der)}|1|{crc:04x}|CERT", "OK ready.*")
        self.wait_line(re.compile(r"^\[CONSOLE\] stream aborted"), 40, mark)
        self.expect_final("STREAM_STATUS", "OK idle")

        self.expect_final("BUTTON|1", "OK button 1")
        self.expect_final("BUTTON|3", "ERR button must be 1 or 2")
        self.expect_final_like("CLEAR_WIFI", "OK network erased.*", 6)
        if self.console.status()["wifi password"] != "unset":
            raise TestFailed("CLEAR_WIFI left the network behind")

        return {"id": status["id"]}

    def check_6(self) -> dict:
        """A simulated power loss before the flag is written leaves the board in factory
        mode. This needs a test image, which is then replaced by the normal one."""
        # Both, before anything happens: without the normal image there is no way back.
        for image in (self.args.fault_image, self.args.image):
            if not Path(image).exists():
                raise TestFailed(f"{image} does not exist: build it first (see the plan)")

        self.remember(ERASED)
        self.remember(FAULT_IMAGE)
        self.install(Path(self.args.fault_image), "--console")

        if self.console.status()["state"] != "FACTORY":
            mark = self.mark()
            self.expect_final("FACTORY_RESET", "OK erased, rebooting into factory mode", 15)
            self.wait_for_boot(mark, "FACTORY")

        mark = self.mark()
        self.console.handshake()
        self.link.write(b"INIT|POWERCUT1\r")
        self.wait_line(re.compile(r"^\[CONSOLE\] test image: losing power"), 15, mark)
        self.wait_for_boot(mark, "FACTORY")

        status = self.console.status()
        self.expect_final("WIFI|a|b", FACTORY_REFUSAL)
        if status["state"] != "FACTORY":
            raise TestFailed(f"the board is {status['state']}")

        self.install(Path(self.args.image), "--console")
        self.forget(FAULT_IMAGE)
        status = self.console.status()
        if status["state"] != "FACTORY":
            raise TestFailed(f"with the normal image again, the board is {status['state']}")
        return {"id_left_behind": status["id"]}

    def restore(self) -> dict:
        """Provision the board again, unattended, after whatever was left undone."""
        if RELEASE_IMAGE in self.undone:
            self.install(Path(self.args.image), "--reset", "--serial-number",
                         self.args.serial_number)
            self.forget(RELEASE_IMAGE)
        if FAULT_IMAGE in self.undone:
            self.install(Path(self.args.image), "--console")
            self.forget(FAULT_IMAGE)

        # provision_device.py leaves a stored network alone. In factory mode, INIT erases it.
        if WRONG_NETWORK in self.undone and self.console.status().get("state") != "FACTORY":
            self.store_right_network()

        device = self.device
        self.close_ports()
        try:
            result = subprocess.run([sys.executable, str(REPO / "tools" / "provision_device.py"),
                                     "--profile", self.args.profile, "--port", device,
                                     "--connect-timeout", str(self.args.join_timeout)],
                                    capture_output=True, text=True, stdin=subprocess.DEVNULL)
            (self.out / "restore.log").write_text(self.redact(result.stdout + result.stderr))
        finally:
            self.open_ports()

        status = self.console.status()
        if status.get("cloud") != "connected":
            raise TestFailed(f"cloud {status.get('cloud')}: see {self.out / 'restore.log'}")
        self.forget(ERASED)
        self.forget(WRONG_NETWORK)
        return {"cloud": status["cloud"], "state": status["state"], "id": status["id"]}

    def back_online(self) -> dict:
        """A run that keeps the board's settings ends with the board as it found it."""
        deadline = time.time() + self.args.join_timeout
        status = {}
        while time.time() < deadline:
            self.watch.check()
            try:
                status = self.console.status()
            except BoardError:
                # It is busy for a moment. The deadline is what counts.
                status = {}
            if status.get("cloud") == "connected" and status.get("update", "").startswith("idle"):
                return {"cloud": status["cloud"], "update": status["update"]}
            time.sleep(2)
        raise TestFailed(f"cloud {status.get('cloud')}, update {status.get('update')}")

    # ---- running them ----------------------------------------------------------------

    def run_step(self, step: Step) -> bool:
        note(f"=== {step.name}: {step.what}")
        started = time.time()
        mark = self.mark()
        record = {"scenario": step.name, "image": Path(self.args.image).name,
                  "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        try:
            record["result"] = step.function()
            self.no_secret_came_back(mark)
            record["outcome"] = "PASS"
        except NotApplicable as reason:
            record["outcome"] = "SKIP"
            record["reason"] = str(reason)
        except (TestFailed, BoardError) as error:
            record["outcome"] = "FAIL"
            record["error"] = str(error)
            if isinstance(error, ChipStuck):
                record["chip_stuck"] = True
                if self.watch.hung():
                    record["error"] += hang_context(self.status_or_nothing())
                    self.rescue_from_hang()
        except Exception as error:  # noqa: BLE001  Nothing a step does may stop the rest.
            record["outcome"] = "FAIL"
            record["error"] = f"{type(error).__name__}: {error}"
        # What the board or a command said. Not the record's own fields: a short name would ruin them.
        for key in ("error", "result", "reason"):
            if key in record:
                record[key] = self.safe_for_results(record[key])
        record["duration"] = round(time.time() - started)
        self.results.append(record)
        with open(self.out / "results.jsonl", "a") as file:
            file.write(json.dumps(record) + "\n")
        note(f"=== {record['outcome']} {step.name} ({record['duration']} s)"
             + (f": {record['error']}" if "error" in record else ""))
        return record["outcome"] != "FAIL"


# Name, method, what it does and whether it erases, in the order they run.
STEPS = [
    ("migration", "migration",
     "if the board still has the shell: update it over the air, and it must migrate", False),
    ("protocol", "protocol",
     "line endings, blank lines, overlong lines, backspace, echo, errors, HELP, STATUS, "
     "NET, STATS", False),
    ("log-lines", "log_lines",
     "every line since a boot is a reply or tagged, log lines carry their module's name, and "
     "none lands in a reply. Saves the same cloud settings again, so it reconnects", False),
    ("boot-input", "boot_input",
     "what is sent during a boot is thrown away, and a raw command right after it works",
     False),
    ("check-2-bad-init", "check_2", "INIT|bad id! returns ERR and changes nothing", False),
    ("check-4-join", "check_4",
     "WIFI reports the join, and the board reconnects after REBOOT. Rewrites the stored "
     "network with the same one", False),
    ("check-5-wrong-password", "check_5",
     "a wrong password reports a failure and the console keeps answering. One restart for a hung "
     "Wi-Fi chip on the way passes, if the driver said so first, it came at the timer's limit, and "
     "that report follows it, and the result says so. Stores a wrong password for a while, then "
     "puts the right one back", False),
    ("settings-kept", "settings_kept",
     "SET_ID and CLEAR_WIFI on a board on the network: the link drops, everything else stays. "
     "Erases the network for a while, then puts it back", False),
    ("bootloader", "bootloader",
     "ENTER_BOOTLOADER and tools/recover.py --console: the window is caught, nothing "
     "is installed", False),
    ("release-image", "release_image",
     "ERASES NOTHING BUT REPLACES THE FIRMWARE TWICE, about four minutes each, and needs the "
     "debug port: a build without the console must still boot and report to the cloud. "
     "Skipped if that image has not been built", True),
    ("check-7-factory-reset", "check_7",
     "ERASES THE BOARD: FACTORY_RESET leads to factory mode", True),
    ("check-1-factory-mode", "check_1",
     "ERASES THE BOARD if it is not erased yet: a boot in factory mode, GET_ID works, "
     "WIFI|a|b and the others are refused, no join for 40 s. Look at LED1 now: a long "
     "flash (half a second) every two seconds", True),
    ("check-1-erased-storage", "check_1_erased_storage",
     "ERASES TF-M'S STORAGE OVER THE DEBUG PORT: the same as above, on storage that holds "
     "nothing at all", True),
    ("check-3-init", "check_3",
     "ERASES THE BOARD: INIT|ABC123 restarts into normal operation", True),
    ("settings", "settings",
     "ERASES THE BOARD'S SETTINGS: SET_ID, WIFI validation, CLOUD, RESET_CONFIG, KEYGEN, "
     "streams, BUTTON, CLEAR_WIFI", True),
    ("check-6-power-loss", "check_6",
     "ERASES THE BOARD AND REPLACES ITS FIRMWARE TWICE, about four minutes each: the test "
     "image, INIT with a power cut before the flag, factory mode, and the normal image "
     "again", True),
    ("restore", "restore",
     "after any of the above: tools/provision_device.py --profile <profile> provisions "
     "the board again, with a new certificate, and it must reach AWS IoT", True),
]


def print_plan(args) -> None:
    print("This prints the plan and has not touched the board.\n")
    undone = load_undone(Path(args.out))
    if undone:
        print(f"An earlier run left this undone, and `restore` puts it right: {sorted(undone)}\n")
    print(f"Images: {args.image}\n        {args.fault_image} (the test image of "
          f"check-6-power-loss)\n        {args.release_image} (of release-image)")
    print("Build them with:\n"
          "  KIND=console firmware/tests/hil/build_image.sh 1.3.0 0 "
          "build-bench/images/console-1.3.0+0.bin\n"
          "  firmware/tests/hil/build_image.sh 1.3.0 0 "
          "build-bench/images/console-fault-1.3.0+0.bin "
          "-Dapp_CONFIG_APP_TEST_FAULT_INIT_POWER_LOSS=y\n"
          "  KIND=release firmware/tests/hil/build_image.sh 1.3.0 0 "
          "build-bench/images/release-check-1.3.0+0.bin -Dapp_CONFIG_APP_CONSOLE=n\n")
    print("The board has to run the console. A board with the older firmware gets it through "
          "the migration step,\nover the air. Without AWS, or to install it another way:\n"
          "  python3 tools/recover.py --reset upload build-bench/images/console-1.3.0+0.bin\n")
    print("In this order:\n")
    for name, _, what, erases in STEPS:
        print(f"  {'[ERASES]' if erases else '[keeps] '} {name}\n           {what}")
    print("\n  run --no-erase runs the [keeps] steps, and then checks that the board is back on "
          "the cloud.\n  run --erase runs everything, and always ends with restore.")


def preflight_problems(args, table: list, undone: set[str]) -> list[str]:
    """What would stop this half way, found now and not after the board has been erased."""
    problems = []
    names = {row[0] for row in table}

    if args.erase or args.command == "restore":
        if not os.access(WIFI_SECRETS, os.R_OK):
            problems.append(f"{WIFI_SECRETS} cannot be read without sudo, so the board could not "
                            "be provisioned again unattended: run python tools/secrets.py wifi "
                            "--unlocked, which replaces a locked file")
        if not OUTPUTS.exists():
            problems.append(f"{OUTPUTS} is missing, and provisioning needs it: deploy the cloud "
                            "stack first (cloud/deploy.sh)")
        try:
            signed_in = subprocess.run(["aws", "sts", "get-caller-identity", "--profile",
                                        args.profile], capture_output=True, text=True,
                                       timeout=60).returncode == 0
        except (OSError, subprocess.SubprocessError):
            signed_in = False
        if not signed_in:
            problems.append(f"the AWS profile {args.profile} is not signed in, and provisioning "
                            f"needs it: aws sso login --profile {args.profile}")

    if args.command == "run" and args.erase:
        if names & {"check-1-erased-storage", "release-image"} and not shutil.which("nrfutil"):
            problems.append("nrfutil is missing, and the steps that use the debug port need it: "
                            "run this from an nRF Connect SDK terminal")
        if "check-6-power-loss" in names:
            problems += [f"{image} does not exist: build it first (see the plan)"
                         for image in (args.image, args.fault_image) if not Path(image).exists()]

    if (undone & {FAULT_IMAGE, RELEASE_IMAGE}) and not Path(args.image).exists():
        problems.append(f"{args.image} does not exist, and the normal image has to go back on the "
                        "board: build it first (see the plan)")
    return problems


RESTORE_COMMAND = "python3 firmware/tests/hil/console_bench.py restore"


def say_what_is_left(bench: ConsoleBench) -> None:
    for what in sorted(bench.undone):
        note(f"!!! THE BOARD IS NOT AS IT WAS: {what}")
    if bench.undone:
        note(f"!!! To put it right: {RESTORE_COMMAND} --out {bench.out}")


def run_steps(bench: ConsoleBench, table: list, args) -> int:
    failures = 0
    restored = False

    def run(step: Step) -> bool:
        nonlocal failures
        passed = bench.run_step(step)
        failures += not passed
        return passed

    for name, method, what, erases in table:
        # Restoring happens last in any case, and only if there is something to restore.
        if name == "restore":
            if not (bench.undone or args.command == "restore"):
                continue
            restored = True

        passed = run(Step(name, what, getattr(bench, method), erases))

        # Without the console on the board, the other steps have nothing to talk to.
        if not passed and (args.stop_on_failure or name == "migration"):
            break

    # Also when --only or --stop-on-failure left it out, but not a second time.
    if not restored and bench.undone - {WRONG_NETWORK}:
        run(Step("restore", "provision the board again", bench.restore, True))
    elif not restored and bench.undone:
        run(Step("network-back", "put the right network back", bench.network_back))

    if args.no_erase:
        run(Step("back-online", "the board is back on the cloud", bench.back_online))
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", nargs="?", default="plan", choices=["plan", "run", "restore"])
    parser.add_argument("--erase", action="store_true",
                        help="run the steps that erase the board, and restore it afterwards")
    parser.add_argument("--no-erase", action="store_true",
                        help="run only the steps that erase nothing")
    parser.add_argument("--only", help="comma-separated names of the steps to run")
    parser.add_argument("--image", default=str(REPO / "build-bench/images/console-1.3.0+0.bin"),
                        help="the signed console image")
    parser.add_argument("--fault-image",
                        default=str(REPO / "build-bench/images/console-fault-1.3.0+0.bin"),
                        help="the signed test image for check-6-power-loss")
    parser.add_argument("--profile", default=os.environ.get("AWS_PROFILE", "cranium"),
                        help="AWS CLI profile for provisioning and the update")
    parser.add_argument("--release-image",
                        default=str(REPO / "build-bench/images/release-check-1.3.0+0.bin"),
                        help="a signed image built without the console, for release-image")
    parser.add_argument("--serial-number", default=DEFAULT_PROBE,
                        help="the debug probe, for the steps that need the debug port")
    parser.add_argument("--port", help="the console's serial port (default: auto)")
    parser.add_argument("--boot-port", help="the port with the bootloader's log (default: auto)")
    parser.add_argument("--join-timeout", type=float, default=600,
                        help="seconds to wait for the network, which a hotspot can make long")
    parser.add_argument("--out", default=str(REPO / "build-hil/console"),
                        help="where logs and results go")
    parser.add_argument("--stop-on-failure", action="store_true")
    args = parser.parse_args()

    if args.command == "plan":
        print_plan(args)
        return 0

    if args.command == "run" and args.erase == args.no_erase:
        parser.error("say whether this may erase the board: --erase or --no-erase")

    table = STEPS
    if args.only:
        names = args.only.split(",")
        unknown = [name for name in names if name not in [row[0] for row in table]]
        if unknown:
            parser.error(f"no such step: {unknown}")
        table = [row for row in table if row[0] in names]

    undone = load_undone(Path(args.out))
    if args.command == "run" and undone:
        parser.error(f"an earlier run left this undone: {sorted(undone)}. Put it right first with: "
                     f"{RESTORE_COMMAND}")

    problems = preflight_problems(args, table, undone)
    if problems:
        parser.error("not starting, because this would fail with the board half done:\n  "
                     + "\n  ".join(problems))

    bench = ConsoleBench(args)
    failures = 0
    interrupted = False
    try:
        # Now, so that a missing file stops this before anything has happened to the board.
        bench.network()

        if args.command == "restore":
            table = [row for row in STEPS if row[0] == "restore"]
        elif args.no_erase:
            refused = [row[0] for row in table if row[3]]
            if refused:
                note(f"not running, because they erase: {', '.join(refused)}")
            table = [row for row in table if not row[3]]

        failures = run_steps(bench, table, args)
    except KeyboardInterrupt:
        note("stopped by hand; nothing more was done to the board")
        interrupted = True
    finally:
        bench.close_ports()

    count = {outcome: sum(record["outcome"] == outcome for record in bench.results)
             for outcome in ("PASS", "FAIL", "SKIP")}
    note(f"{count['PASS']} passed, {count['FAIL']} failed, {count['SKIP']} did not apply; "
         f"results in {bench.out / 'results.jsonl'}")
    say_what_is_left(bench)
    if interrupted:
        return 130
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
