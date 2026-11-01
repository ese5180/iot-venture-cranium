#!/usr/bin/env python3
"""Hardware-in-the-loop tests of firmware updates: a real board and the deployed cloud.

    python3 firmware/tests/hil/ota_bench.py status
    python3 firmware/tests/hil/ota_bench.py update IMAGE [IMAGE ...]    install one after the other
    python3 firmware/tests/hil/ota_bench.py SCENARIO IMAGE
    python3 firmware/tests/hil/ota_bench.py SCENARIO IMAGE --cloud-only   no serial port, no probe

Scenarios, each with the outcome it insists on:

    decline        Button 2 on an offer: rejected, nothing downloaded
    cancel-offer   the offer is cancelled before any button: board back to idle
                   These two need an image that makes an offer: see FIRST_WITH_NO_OFFER.
    cancel-stop    cancelled with force in mid-download: nothing installed
    older          a job for a version that is not newer: rejected as not_newer
    corrupt        one flipped byte in the download: failed as digest_mismatch
    bad-signature  the image signed with another key: the bootloader refuses it
    faulty         IMAGE misbehaves on trial: the bootloader brings the old image back
    reset-download a reset in mid-download: job failed as interrupted, old image runs
    reset-swap     a reset while the bootloader swaps: the swap finishes, update succeeds
    recovery       IMAGE over the bootloader's serial recovery; a badly signed one is refused
    chip-dead      IMAGE is a test image that a run of `update` has confirmed through a real trial,
                   and it runs now. One TEST_WIFI_DEAD, and then nothing on the console until the
                   board has restarted itself: the driver saying that the chip stopped, the line
                   that says why within the limit, a software reset, back on the cloud, and no
                   revert. Build the image with
                   -Dapp_CONFIG_APP_TEST_FAULT_WIFI_DEAD=y -Dapp_CONFIG_NRF_WIFI_RPU_RECOVERY=n
    chip-dead-cloud  the same with no cable, always cloud-only. IMAGE is a newer test image that stops
                   the chip by itself, once per install, 300 s after it is confirmed. It is installed
                   over the air, then the shadow has to show: heartbeats that stop, a restart by
                   the timers within their limit, the same image confirmed, and no second time.
                   Build the image with KIND=wifi-dead-auto, and those options, and
                   -Dapp_CONFIG_APP_TEST_WIFI_DEAD_AFTER_SECONDS=300

By default a release goes through the deployed console API (--via api): the API function
is invoked directly as the release manager named by --as, so upload validation, the release
list, the audit log and the job come from the code that serves the console. Scenarios
that need what the console rightly refuses create the job themselves. Their ids start with
"cranium-bench-": the download role only serves jobs named cranium-*, and the console
lists only its own format, so they stay out of its deployment list.

Firmware from 1.7.2 on starts an update by itself. Older images, and the frozen golden image above
all, wait for Button 1. Every scenario handles both: if the board reports awaiting_user the bench
presses the button and insists that the update then starts, and if it has already started the bench
carries on. "Pressing" a button uses the console's BUTTON command, which takes the path of the real
button. With no console, the bench says so and waits for a person to press it.

With no console found, or with --cloud-only, the bench follows the board with AWS credentials through
the job execution and the device shadow alone: firmware version, confirmed, update state, last
result, heartbeat age and the stuck count. No serial port and no debug probe are touched. update, older,
corrupt, bad-signature, faulty and cancel-stop then work, and each says in its result that it had no
console and no bootloader log. reset-download, reset-swap, chip-dead and recovery cannot, and they
end as NOT_APPLICABLE. --thing names the board, if the account has more than one.

Everything both serial ports print goes to --out, with time stamps. A scenario ends with PASS or
FAIL, with NOT_RUN if it did not touch the board, or with NOT_APPLICABLE if what it tests does not
exist on the image that runs or cannot be done without a console, and appends one line to results.jsonl
there, with the mode it ran in. No network name goes into that file: a run's results get quoted. The
exit status is 0 if nothing failed and something passed, 1 if something failed, and 3 if nothing failed
because nothing was applicable.

A wait for the board gives up early if the driver keeps saying that the Wi-Fi chip has stopped
answering and the board has not restarted by then: see WifiWatch.

The board may also run firmware from before the console, with a Zephyr shell on the port:
tools/board.py speaks that as well, so that an update from it to this firmware can be run
and followed from start to finish.

Needs the AWS CLI with a signed-in profile (AWS_PROFILE, default cranium), the board on
USB, and an nRF Connect SDK terminal for pyserial, imgtool and nrfutil.
"""

import argparse
import base64
import collections
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

import serial  # noqa: E402
from board import BoardError, Console, find_console_port  # noqa: E402
from serial.tools import list_ports  # noqa: E402

OUTPUTS = REPO / "cloud" / ".deploy" / "outputs.json"
FINISHED = {"SUCCEEDED", "FAILED", "REJECTED", "REMOVED", "CANCELED", "TIMED_OUT"}
URL_EXPIRES_SEC = 600
JOB_TIMEOUT_MIN = 30
BOOT_SECONDS = 30

# The first firmware built with CONFIG_APP_OTA_REQUIRE_USER_CONSENT off, by default, so that an update
# starts by itself and there is no offer. Older images have one, the frozen golden image among them.
FIRST_WITH_NO_OFFER = (1, 7, 2)
# What a board says once an update is on its way. Before the cloud has agreed it says downloading too.
UNDER_WAY = ("downloading", "verifying", "rebooting", "testing")
# How long a press has to get an update going. A person also has to get to the board.
PRESS_SECONDS = 20
PERSON_PRESS_SECONDS = 180
EXIT_NOT_APPLICABLE = 3
# With no console, what a board counts as is what the console's API makes of it: see
# cloud/api/src/lib/shadow.mjs. test_board.py checks that these are the same.
ONLINE_SECONDS = 90
RESTART_WINDOW_SECONDS = 240
CLOUD_ONLY_SAYS = "no console and no bootloader log: this rests on the job's status and reason and the shadow only"
# chip-dead-cloud: when the image fires, in APP_TEST_WIFI_DEAD_AFTER_SECONDS, how much later than that
# the heartbeats may be seen to stop, and how long a board takes from a restart to the cloud.
SELF_FIRE_SECONDS = 300
SELF_FIRE_SLACK_SECONDS = 180
BACK_ON_CLOUD_SECONDS = 180

# What the driver logs when the Wi-Fi chip stops answering: hal_api_common.c and fmac_api.c in the SDK.
DRIVER_HANG = re.compile(r"hal_rpu_ready_wait|Timeout waiting to get free cmd buff|RPU is not ready")
WIFI_ANSWERED = re.compile(r"^\[WIFI\] (connected |failed reason=(?!no answer$|request refused$))")
WIFI_CONNECTED = re.compile(r"^\[WIFI\] connected ip=(\S+)")
WIFI_DISCONNECTED = re.compile(r"^\[WIFI\] disconnected")
CLOUD_DISCONNECTED = re.compile(r"^\[app\] Disconnected from AWS IoT")
BOOT_BOX = re.compile(r"^\[BOOT\] ")
STUCK_RESTART = re.compile(r"^\[STUCK\] restarting reason=(\w+) count=(\d+)$")
STUCK_AT_BOOT = re.compile(r"^\[stuck\] WRN: .*reason=(\w+) count=(\d+)$")
FATAL_LINE = re.compile(r"ASSERTION FAIL|FATAL ERROR")
BOOTLOADER_STARTED = r"Starting bootloader"
BOOTLOADER_JUMPED = r"Jumping to the first image slot"
ANY_SWAP = r"Swap type: (test|revert)"
RESET_LINE = re.compile(r"Reset\s+(.*?)\s*\|")
DEAD_COMMAND = "TEST_WIFI_DEAD"

# The firmware's limits, from src/stuck_policy.h. test_board.py checks that these are the same.
WIFI_SILENT_SECONDS = 120
NO_CLOUD_SECONDS = 900
# A request to disconnect, on a supplicant that has stalled: its answer to `disconnect`, the wait for the
# state, and its answer to `remove_network all`. CONFIG_WIFI_NM_WPA_CTRL_RESP_TIMEOUT_S is 15, and
# DISCONNECT_TIMEOUT_MS in supp_api.c is 5 s.
DISCONNECT_REQUEST_SECONDS = 15 + 5 + 15
# JOIN_QUIET_MS in src/join_policy.h: nothing goes to the stack this soon after the link changed.
JOIN_QUIET_SECONDS = 5
# How long a wait goes on while the driver says that the chip has stopped answering. A board with no
# count and the link gone has restarted by then: a WIFI command can be held for its quiet time, then the
# request to disconnect can take all it can take before the silence starts, and the first line from
# the driver can come as soon as that request. Correct firmware can take longer: a count above 0 holds
# the restart back for 5 minutes to 6 hours, no_cloud takes 15 minutes for a chip that hung while
# associated, and update_stall 10 minutes. So reaching this says that the bench has stopped waiting,
# and not that the firmware did anything wrong. chip-dead has its own wait, for that reason.
HANG_PATIENCE_SECONDS = JOIN_QUIET_SECONDS + DISCONNECT_REQUEST_SECONDS + WIFI_SILENT_SECONDS + 30
# Driver lines further apart than this are not the same hang.
HANG_QUIET_SECONDS = 15
# How far the time of a line can be from what it marks. The main loop can be busy with the chip.
BOUND_SLACK_SECONDS = 30
# Connected when the chip dies. It takes the next heartbeat, the shadow report (30 s from 1.7.1, 60 s
# before that), and TCP giving up on it for the cloud to go, and then NO_CLOUD_SECONDS. Or the link
# goes before that.
CHIP_DEAD_WAIT_SECONDS = 60 + 60 + NO_CLOUD_SECONDS + BOUND_SLACK_SECONDS
# The next shadow report follows a moment after the job's final status.
SHADOW_CATCH_UP_SECONDS = 8
# What is left of a status in a failure's text. The rest holds the network and the account's names.
STATUS_SHOWN_IN_ERRORS = ("firmware", "wifi link", "cloud", "update", "heartbeat age")
NETWORK_NAME_SHOWN = "<network>"
ACCOUNT_SHOWN = "<account>"
# What says whose account this is, wherever it comes from: an error from the AWS CLI, a URL.
ACCOUNT_PATTERNS = (re.compile(r"\barn:aws[a-z-]*:[^\s\"',;)\]}]+"),
                    re.compile(r"[\w.-]+\.amazonaws\.com(?:/[^\s\"',;)\]}]*)?"),
                    re.compile(r"(?<![\w.-])\d{12}(?![\w.-])"))
# Of the cloud stack's outputs, those that are no name of anything in the account.
OUTPUTS_THAT_NAME_NOTHING = ("Region", "DeployedCommit", "DeployedTree")
# Fields of a result that the bench itself worked out. A short network name could ruin them, and
# chip-dead looks up a digest and a version in the results of an earlier run.
OWN_FIELDS = ("from", "to", "job", "sha256", "running", "firmware", "trial_job")


class TestFailed(RuntimeError):
    pass


class ChipStuck(TestFailed):
    """The Wi-Fi chip has stopped answering, and the board has not restarted for it."""


class NotRun(Exception):
    """What the scenario needs is not there, and nothing has been done to the board."""


class NotApplicable(Exception):
    """What the scenario tests does not exist on this image, or it cannot be done without a console.
    That is no pass and no failure, and nothing has been done to the board."""


def asks_for_button(firmware: str) -> bool:
    """Whether firmware of this version holds an update until Button 1 is pressed. What cannot be
    read counts as asking: the scenario then finds out from the board."""
    match = re.match(r"(\d+)\.(\d+)\.(\d+)", firmware or "")
    return match is None or tuple(map(int, match.groups())) < FIRST_WITH_NO_OFFER


def update_state(status: dict | None) -> str:
    """The first word of what STATUS says about an update."""
    return (status or {}).get("update", "").split(" ")[0]


def status_from_shadow(thing: str, document: dict, now: float) -> dict:
    """What a console would say about the board, as far as its shadow can. The keys that are there
    mean what STATUS's do, and the rest only a shadow has."""
    reported = document.get("state", {}).get("reported", {})
    fw, ota, stuck = (reported.get(key) or {} for key in ("fw", "ota", "stuck"))
    seen = document.get("metadata", {}).get("reported", {}).get("uptime", {}).get("timestamp")
    state = ota.get("state", "unknown")
    window = RESTART_WINDOW_SECONDS if state == "rebooting" else ONLINE_SECONDS
    age = now - seen if isinstance(seen, (int, float)) else None
    return {"thing name": thing, "firmware": fw.get("version"), "confirmed": fw.get("confirmed"),
            "cloud": "connected" if age is not None and age < window else "quiet",
            "update": f"{state} (last: {ota.get('last', 'none')})", "job": ota.get("job"),
            "progress": ota.get("progress"), "last": ota.get("last"), "error": ota.get("error"),
            "uptime": reported.get("uptime"), "heartbeat": seen,
            "heartbeat age": None if age is None else round(age),
            "stuck count": stuck.get("count"), "stuck reason": stuck.get("reason")}


def note(text: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {text}", flush=True)


def scrub(value, names, shown=NETWORK_NAME_SHOWN):
    """A result or a failure's text with the given names taken out, wherever they are in it, and
    what says whose account this is. Before it becomes JSON, which would write a name's apostrophe
    in a way that no longer matches. The longest name goes first: one can hold another."""
    if isinstance(value, str):
        for name in sorted(filter(None, names), key=len, reverse=True):
            value = value.replace(name, shown)
        for pattern in ACCOUNT_PATTERNS:
            value = pattern.sub(ACCOUNT_SHOWN, value)
        return value
    if isinstance(value, dict):
        return {key: item if key in OWN_FIELDS else scrub(item, names, shown)
                for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [scrub(item, names, shown) for item in value]
    return value


def account_names_in(outputs: Path) -> set[str]:
    """The names in the cloud stack's outputs, for scrub(). None if there are no outputs yet."""
    try:
        values = json.loads(outputs.read_text())
    except (OSError, ValueError):
        return set()
    return {value for key, value in values.items()
            if key not in OUTPUTS_THAT_NAME_NOTHING and isinstance(value, str)}


def hang_context(status: dict | None) -> str:
    """What a reader of the result needs to tell a board that failed from one that was going to
    restart later than the bench waited."""
    status = status or {}
    return (f" (stuck count {status.get('stuck count', 'not known')}, "
            f"update {status.get('update', 'not known')})")


class WifiWatch:
    """What the board says about its Wi-Fi chip, line by line, for the benches' waits.

    A wait can be long for a good reason: a phone's hotspot can take minutes to be seen. A chip that
    has stopped answering is no such reason. On firmware that restarts for it, the driver's lines
    end with a restart, and on firmware that does not, they never end. Either way, there is no use
    in waiting ten minutes for a join after that.

    A hang is lines that keep coming: one line now and another an hour later are not one. feed() and
    clear() run on the serial port's thread and the rest on the bench's, hence the lock."""

    def __init__(self, clock=time.time):
        self.clock = clock
        self.lock = threading.Lock()
        self.first = None
        self.last = None
        # The reasons of the restarts that the board announced, in order.
        self.restarts = []

    def feed(self, line: str) -> None:
        restart = STUCK_RESTART.match(line)
        if restart:
            self.restarts.append(restart.group(1))
            self.clear()
        elif BOOT_BOX.match(line) or WIFI_ANSWERED.match(line):
            self.clear()
        elif DRIVER_HANG.search(line):
            now = self.clock()
            with self.lock:
                if self.last is None or now - self.last > HANG_QUIET_SECONDS:
                    self.first = now
                self.last = now

    def clear(self) -> None:
        with self.lock:
            self.first = self.last = None

    def seconds_hung(self) -> float | None:
        """How long it has been saying so, once that is long enough to stop waiting."""
        with self.lock:
            first, last = self.first, self.last
        if first is None:
            return None
        now = self.clock()
        if now - first >= HANG_PATIENCE_SECONDS and now - last <= HANG_QUIET_SECONDS:
            return now - first
        return None

    def hung(self) -> bool:
        return self.seconds_hung() is not None

    def check(self) -> None:
        seconds = self.seconds_hung()
        if seconds is not None:
            raise ChipStuck(f"the driver has been saying that the Wi-Fi chip has stopped answering "
                            f"for {seconds:.0f} s, and the bench has stopped waiting for a restart")


def judge_stuck_restart(lines: list[tuple[float, str]], boot_lines: list[str], started: float,
                        count_before: int) -> dict:
    """Whether a stop of the chip's power at the time `started` went as it should, from what the
    two serial ports showed since then. It never hands back a line of the board's: only its own
    words and numbers, so that nothing the board said gets into the results."""
    restarts = [(at, STUCK_RESTART.match(text)) for at, text in lines if STUCK_RESTART.match(text)]
    if len(restarts) != 1:
        raise TestFailed(f"{len(restarts)} [STUCK] lines since the command, and there should be one")
    at, restart = restarts[0]
    reason, count = restart.group(1), int(restart.group(2))

    if count != count_before + 1:
        raise TestFailed(f"the [STUCK] line says count={count}, after a count of {count_before}")

    # What the timer's clock started from, which is what its limit is measured from.
    before = [(when, text) for when, text in lines if when <= at]
    if reason == "wifi_silent":
        limit = WIFI_SILENT_SECONDS
        marks = [when for when, text in before
                 if WIFI_DISCONNECTED.match(text) or WIFI_ANSWERED.match(text)]
        if not any(WIFI_DISCONNECTED.match(text) for _, text in before):
            raise TestFailed("wifi_silent, and no line saying that the link went")
        mark = marks[-1]
    elif reason == "no_cloud":
        limit = NO_CLOUD_SECONDS
        marks = [when for when, text in before if CLOUD_DISCONNECTED.match(text)]
        if not marks:
            raise TestFailed("no_cloud, and no line saying that the cloud went")
        mark = marks[0]
    else:
        raise TestFailed(f"the timer that fired is {reason}, which has nothing to do with this")

    waited = at - mark
    if abs(waited - limit) > BOUND_SLACK_SECONDS:
        raise TestFailed(f"{reason} fired after {waited:.0f} s, and its limit is {limit} s")

    if any(FATAL_LINE.search(text) for _, text in lines):
        raise TestFailed("a fatal error since the command: that is not the timer's restart")

    # Nothing else shows that the command did anything. A hotspot that loses its internet for as
    # long as the timer takes would look the same, with a chip that never stopped.
    driver_lines = sum(bool(DRIVER_HANG.search(text)) for _, text in before)
    if driver_lines == 0:
        raise TestFailed("no line from the driver says that the chip stopped, so this restart says "
                         "nothing about a chip that stopped")

    starts = sum(bool(re.search(BOOTLOADER_STARTED, line)) for line in boot_lines)
    if starts != 1:
        raise TestFailed(f"{starts} boots since the command, and there should be one")
    if any(re.search(ANY_SWAP, line) for line in boot_lines):
        raise TestFailed("the bootloader swapped images: this image was reverted")
    if not any(re.search(BOOTLOADER_JUMPED, line) for line in boot_lines):
        raise TestFailed("the boot log does not show the bootloader starting the image")

    after = [text for when, text in lines if when > at]
    told = next((STUCK_AT_BOOT.match(text) for text in after if STUCK_AT_BOOT.match(text)), None)
    if told is None or told.group(1) != reason or int(told.group(2)) != count:
        raise TestFailed("the next boot does not report the same reason and count from its record")

    connected = next((WIFI_CONNECTED.match(text) for text in after if WIFI_CONNECTED.match(text)), None)
    if connected is None or connected.group(1) == "none":
        raise TestFailed("no line saying that the board joined with an address, after the restart")

    return {"reason": reason, "count": count, "limit": limit, "fired_after": round(waited),
            "seconds_from_command": round(at - started), "driver_lines": driver_lines}


def judge_stuck_during_join(lines: list[tuple[float, str]], started: float) -> list[str]:
    """A join that is meant to fail, on a chip that may hang on the way, as it has done once. A
    restart for that is what firmware with the timers does, and that is the only restart that passes
    here. `lines` are what the console showed since the command at the time `started`. Returns the
    reasons of the restarts, which is nothing or `wifi_silent`."""
    if any(FATAL_LINE.search(text) for _, text in lines):
        raise TestFailed("a fatal error since the command: that is no restart for a hung chip")

    restarts = [(at, STUCK_RESTART.match(text)) for at, text in lines if STUCK_RESTART.match(text)]
    if not restarts:
        return []
    if len(restarts) > 1:
        raise TestFailed(f"{len(restarts)} restarts for being stuck, and a hung chip needs one")

    at, restart = restarts[0]
    reason, count = restart.group(1), int(restart.group(2))
    if reason != "wifi_silent":
        raise TestFailed(f"restarted for {reason}, which has nothing to do with this join")

    before = [(when, text) for when, text in lines if when <= at]
    if not any(DRIVER_HANG.search(text) for _, text in before):
        raise TestFailed("restarted for wifi_silent with no line from the driver: as far as anything "
                         "shows, that was a healthy chip")

    # What the silence is counted from: the link going, or the last thing the stack said.
    mark = max([started] + [when for when, text in before
                            if WIFI_DISCONNECTED.match(text) or WIFI_ANSWERED.match(text)])
    waited = at - mark
    if waited < WIFI_SILENT_SECONDS - BOUND_SLACK_SECONDS:
        raise TestFailed(f"wifi_silent fired after {waited:.0f} s, and its limit is "
                         f"{WIFI_SILENT_SECONDS} s")
    # From a count of 1 up, the back-off holds it for longer, and that is as it should be.
    if count == 1 and waited > WIFI_SILENT_SECONDS + BOUND_SLACK_SECONDS:
        raise TestFailed(f"wifi_silent fired after {waited:.0f} s, with no count before it, and its "
                         f"limit is {WIFI_SILENT_SECONDS} s")
    return [reason]


class LoggedPort:
    """A serial port read by its own thread, so that nothing it prints is ever missed."""

    def __init__(self, device: str, path: Path, on_line=None, redact=None):
        self.port = serial.Serial(device, 115200, timeout=0.1)
        self.log = open(path, "a", buffering=1, errors="replace")
        self.on_line = on_line
        self.redact = redact
        self.chunks = collections.deque()
        self.ready = threading.Event()
        self.stopping = False
        self.partial = b""
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

    def _pump(self) -> None:
        while not self.stopping:
            try:
                data = self.port.read(4096)
            except (OSError, serial.SerialException):
                time.sleep(0.5)
                continue
            if not data:
                continue
            self.chunks.append(data)
            self.ready.set()
            self.partial += data
            while b"\n" in self.partial:
                line, self.partial = self.partial.split(b"\n", 1)
                text = line.decode("utf-8", "replace").rstrip("\r")
                if self.redact:
                    text = self.redact(text)
                self.log.write(f"{time.strftime('%H:%M:%S')} {text}\n")
                if self.on_line:
                    self.on_line(text)

    # The part of the pyserial interface that board.Console uses.
    def read(self, size: int) -> bytes:
        if not self.chunks and not self.ready.wait(0.2):
            return b""
        self.ready.clear()
        data = b""
        while self.chunks and len(data) < size:
            data += self.chunks.popleft()
        return data

    def write(self, data: bytes) -> int:
        return self.port.write(data)

    def reset_input_buffer(self) -> None:
        self.chunks.clear()
        self.ready.clear()

    def close(self) -> None:
        self.stopping = True
        self.thread.join(timeout=2)
        self.port.close()
        self.log.close()


class BenchConsole(Console):
    """board.Console on a port that keeps a log."""

    def __init__(self, device: str, path: Path, on_line=None):
        super().__init__(device, LoggedPort(device, path, on_line))


class Aws:
    def __init__(self, profile: str, region: str):
        self.base = ["aws", "--profile", profile, "--region", region, "--output", "json",
                     "--no-cli-pager"]

    def call(self, *args: str, check: bool = True) -> dict:
        result = subprocess.run(self.base + list(args), capture_output=True, text=True)
        if result.returncode != 0:
            if check:
                raise TestFailed(f"aws {' '.join(args[:2])}: {result.stderr.strip()[:400]}")
            return {"__error__": result.stderr}
        return json.loads(result.stdout) if result.stdout.strip() else {}


def image_version(data: bytes) -> str:
    """The version in an MCUboot header."""
    magic = int.from_bytes(data[0:4], "little")
    if magic != 0x96f3b83d:
        raise TestFailed("not an MCUboot image")
    major, minor = data[20], data[21]
    revision = int.from_bytes(data[22:24], "little")
    build = int.from_bytes(data[24:28], "little")
    return f"{major}.{minor}.{revision}+{build}"


def find_console(forced_off: bool) -> str | None:
    """The console's port, or None if this run has none."""
    if forced_off:
        return None
    try:
        return find_console_port()
    except BoardError as error:
        note(f"no console: {error} Following the board through the cloud alone")
        return None


class Bench:
    # Stand-ins for this class get a console unless they ask for none.
    cloud_only = False

    def __init__(self, args):
        self.args = args
        self.outputs = json.loads(OUTPUTS.read_text())
        self.region = self.outputs["Region"]
        self.bucket = self.outputs["FirmwareBucketName"]
        self.aws = Aws(os.environ.get("AWS_PROFILE", "cranium"), self.region)
        self.out = Path(args.out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.boot_lines = collections.deque(maxlen=4000)
        self.console_log = []
        self.watch = WifiWatch()
        self.network_names = set()
        self.account_names = account_names_in(OUTPUTS)
        self.chip_stuck = False
        self.thing = args.thing
        self.release_manager = None
        self.presign_role = None
        console_device = find_console(args.cloud_only)
        self.cloud_only = console_device is None
        if self.cloud_only:
            self.boot = None
            self.console = None
            self.thing = self.thing or self.only_thing()
            return
        ports = sorted(p.device for p in list_ports.comports()
                       if p.vid == 0x1366 and "usbmodem" in p.device.lower())
        boot_device = next(p for p in ports if p != console_device)
        self.boot = LoggedPort(boot_device, self.out / "vcom0-boot.log", self.boot_lines.append)
        self.console = BenchConsole(console_device, self.out / "vcom1-app.log", self.on_console_line)

    def close(self) -> None:
        if self.boot is not None:
            self.boot.close()
        if self.console is not None:
            self.console.serial.close()

    def only_thing(self) -> str:
        """With no console to say which board this is, there has to be just one to choose from."""
        reply = self.aws.call("iot", "list-things", check=False)
        if "__error__" in reply:
            raise TestFailed(f"list-things: {reply['__error__'].strip()[:300]}")
        things = [thing["thingName"] for thing in reply.get("things", [])
                  if thing.get("thingName", "").startswith("cranium-")]
        if len(things) != 1:
            raise TestFailed(f"{len(things)} boards in this account: name one with --thing")
        return things[0]

    # ---- the board ----------------------------------------------------------------

    def on_console_line(self, line: str) -> None:
        self.console_log.append((time.time(), line))
        self.watch.feed(line)

    def status(self) -> dict | None:
        if self.cloud_only:
            try:
                return status_from_shadow(self.thing, self.shadow_document(), time.time())
            except (TestFailed, ValueError, KeyError):
                return None
        try:
            status = self.console.status()
        except BoardError:
            return None
        # Any failure from now on knows what to take out of its text.
        if status.get("wifi network", "unset") != "unset":
            self.network_names.add(status["wifi network"])
        return status

    def safe_for_results(self, value):
        """What goes into results.jsonl: no network's name and no name of the account's."""
        names = self.account_names | ({self.thing} if self.thing else set())
        return scrub(scrub(value, names, ACCOUNT_SHOWN), self.network_names)

    def rescue(self) -> None:
        """A hung chip stays hung until a restart, and the board would stay off the network."""
        note("restarting the board, which is what clears a hung Wi-Fi chip")
        try:
            self.console.exchange("REBOOT")
        except BoardError as error:
            note(f"the restart was not answered: {error}")
        self.watch.clear()

    def wait_status(self, description: str, predicate, timeout: float, every: float = 2) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.watch.check()
            status = self.status()
            if status and predicate(status):
                return status
            time.sleep(every)
        last = self.status() or {}
        shown = {key: last[key] for key in STATUS_SHOWN_IN_ERRORS if key in last}
        raise TestFailed(f"timed out after {timeout:.0f} s waiting for: {description}; last status {shown}")

    def wait_online(self, timeout: float = 240) -> dict:
        status = self.wait_status("the board to be connected and idle",
                                  lambda s: s.get("cloud") == "connected"
                                  and s.get("update", "").startswith("idle"), timeout)
        self.thing = status["thing name"]
        return status

    def by_a_person(self) -> bool:
        return self.cloud_only or self.args.real_button

    def press(self, button: int) -> None:
        if self.by_a_person():
            note(f"THE FIRMWARE ON THE BOARD WAITS FOR BUTTON {button}: PRESS IT ON THE BOARD NOW. "
                 f"Waiting for up to {PERSON_PRESS_SECONDS} s")
            return
        self.console.press(button)
        note(f"pressed Button {button}")

    def reset_board(self) -> None:
        # The reset pin, as with the RESET button: a system reset goes through the CPU's
        # debug access, which is refused while the bootloader is in the middle of a swap.
        result = subprocess.run(["nrfutil", "device", "reset", "--reset-kind", "RESET_PIN",
                                 "--serial-number", self.args.serial_number],
                                capture_output=True, text=True)
        if result.returncode != 0:
            raise TestFailed(f"the reset failed: {(result.stderr or result.stdout).strip()[:300]}")
        note("reset the board through its reset pin")

    def boot_log_has(self, pattern: str, since: int = 0) -> bool:
        lines = list(self.boot_lines)[since:]
        return any(re.search(pattern, line) for line in lines)

    # ---- the cloud ----------------------------------------------------------------

    def shadow_document(self) -> dict:
        with tempfile.NamedTemporaryFile(suffix=".json") as file:
            result = subprocess.run(self.aws.base + ["iot-data", "get-thing-shadow", "--thing-name",
                                                     self.thing, file.name],
                                    capture_output=True, text=True)
            if result.returncode != 0:
                raise TestFailed(f"get-thing-shadow: {result.stderr.strip()[:300]}")
            return json.loads(Path(file.name).read_text())

    def shadow(self) -> dict:
        return self.shadow_document()["state"]["reported"]

    def execution(self, job_id: str) -> dict:
        reply = self.aws.call("iot", "describe-job-execution", "--job-id", job_id, "--thing-name",
                              self.thing, check=False)
        return reply.get("execution", {})

    def wait_job(self, job_id: str, timeout: float, follow=None) -> dict:
        """Wait for the execution to finish, reporting every step it takes."""
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            self.watch.check()
            execution = self.execution(job_id)
            status = execution.get("status")
            details = execution.get("statusDetails", {}).get("detailsMap", {})
            seen = (status, json.dumps(details, sort_keys=True))
            if seen != last:
                note(f"job {status} {details}")
                last = seen
            if status in FINISHED:
                return execution
            if follow:
                follow()
            time.sleep(4)
        raise TestFailed(f"job {job_id} did not finish in {timeout:.0f} s: {last}")

    def put_object(self, data: bytes, name: str) -> None:
        with tempfile.NamedTemporaryFile(suffix=".bin") as file:
            file.write(data)
            file.flush()
            checksum = base64.b64encode(hashlib.sha256(data).digest()).decode()
            # The bucket refuses an upload that does not ask for a new key. The name
            # is the digest of the content, so a key that is taken holds these bytes.
            reply = self.aws.call("s3api", "put-object", "--bucket", self.bucket, "--key",
                                  f"firmware/{name}.bin", "--body", file.name,
                                  "--checksum-sha256", checksum, "--if-none-match", "*",
                                  check=False)
            if "__error__" in reply and "PreconditionFailed" not in reply["__error__"]:
                raise TestFailed(f"put-object: {reply['__error__'].strip()[:300]}")

    def bench_job(self, version: str, size: int, sha256: str, object_name: str | None = None) -> str:
        """A job as the console makes one, for what the console itself would refuse."""
        if self.presign_role is None:
            reply = self.aws.call("cloudformation", "describe-stack-resource", "--stack-name",
                                  "cranium-ota", "--logical-resource-id", "PresignRole")
            name = reply["StackResourceDetail"]["PhysicalResourceId"]
            self.presign_role = self.aws.call("iam", "get-role", "--role-name", name)["Role"]["Arn"]
        url = (f"https://s3.{self.region}.amazonaws.com/{self.bucket}/firmware/"
               f"{object_name or sha256}.bin")
        document = json.dumps({"op": "fw_update", "v": 1, "fw": {
            "version": version, "size": size, "sha256": sha256,
            "url": f"${{aws:iot:s3-presigned-url-v2:{url}}}"}}, separators=(",", ":"))
        job_id = f"cranium-bench-{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}-{secrets.token_hex(2)}"
        account_arn = self.aws.call("iot", "describe-thing", "--thing-name", self.thing)["thingArn"]
        self.aws.call("iot", "create-job", "--job-id", job_id, "--targets", account_arn,
                      "--target-selection", "SNAPSHOT", "--document", document,
                      "--description", "Hardware test bench",
                      "--presigned-url-config",
                      json.dumps({"roleArn": self.presign_role, "expiresInSec": URL_EXPIRES_SEC}),
                      "--timeout-config",
                      json.dumps({"inProgressTimeoutInMinutes": JOB_TIMEOUT_MIN}))
        note(f"created {job_id} for {version}")
        return job_id

    def api(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        """Invoke the deployed API function, as the gateway does for a signed-in user."""
        if self.release_manager is None:
            self.release_manager = self.find_release_manager()
        now = int(time.time())
        event = {
            "version": "2.0", "routeKey": "ANY /api/{proxy+}", "rawPath": path, "rawQueryString": "",
            "headers": {"content-type": "application/json", "user-agent": "cranium-ota-bench"},
            "requestContext": {
                "authorizer": {"jwt": {"claims": {
                    "client_id": self.outputs["UserPoolClientId"],
                    "cognito:groups": "[release-managers]", "exp": str(now + 300), "iat": str(now),
                    "scope": "openid cranium/console", "sub": self.release_manager,
                    "token_use": "access", "username": self.release_manager},
                    "scopes": ["cranium/console"]}},
                "http": {"method": method, "path": path, "protocol": "HTTP/1.1",
                         "sourceIp": "127.0.0.1", "userAgent": "cranium-ota-bench"},
                "requestId": f"bench-{secrets.token_hex(8)}", "routeKey": "ANY /api/{proxy+}",
                "stage": "$default", "timeEpoch": now * 1000},
            "isBase64Encoded": False}
        if body is not None:
            event["body"] = json.dumps(body)
        with tempfile.TemporaryDirectory() as folder:
            request, answer = Path(folder) / "event.json", Path(folder) / "answer.json"
            request.write_text(json.dumps(event))
            reply = self.aws.call("lambda", "invoke", "--function-name",
                                  self.outputs["ApiFunctionName"], "--cli-read-timeout", "60",
                                  "--payload", f"fileb://{request}", str(answer))
            if reply.get("FunctionError"):
                raise TestFailed(f"the API function failed: {answer.read_text()[:400]}")
            response = json.loads(answer.read_text())
        return response["statusCode"], json.loads(response.get("body") or "{}")

    def find_release_manager(self) -> str:
        users = self.aws.call("cognito-idp", "list-users-in-group", "--user-pool-id",
                              self.outputs["UserPoolId"], "--group-name", "release-managers")["Users"]
        for user in users:
            attributes = {a["Name"]: a["Value"] for a in user["Attributes"]}
            wanted = self.args.as_user == attributes.get("email")
            if wanted and user["Enabled"] and user["UserStatus"] == "CONFIRMED":
                note(f"acting in the API as {attributes.get('email')}")
                return attributes["sub"]
        raise TestFailed(f"{self.args.as_user} is not an enabled, confirmed release manager: "
                         "is the first sign-in to the console still outstanding?")

    def release(self, data: bytes, filename: str) -> tuple[str, str]:
        """Upload through the console API, unless that release is already registered."""
        version = image_version(data)
        # The console takes letters, digits, dots, dashes and underscores in a file name.
        filename = re.sub(r"[^A-Za-z0-9._-]", "-", filename)[:64]
        status, body = self.api("POST", "/api/firmware", {
            "filename": filename, "notes": "Uploaded by the hardware test bench",
            "data": base64.b64encode(data).decode()})
        if status == 409 and body.get("error", {}).get("code") == "version_exists":
            note(f"release {version} is already registered")
        elif status not in (200, 201):
            raise TestFailed(f"upload of {version} answered {status}: {body}")
        else:
            note(f"uploaded release {version} through the console API")
        return version, hashlib.sha256(data).hexdigest()

    def deploy(self, version: str) -> str:
        status, body = self.api("POST", "/api/deployments", {
            "version": version, "things": [self.thing], "note": "Hardware test bench"})
        if status not in (200, 201):
            raise TestFailed(f"deployment of {version} answered {status}: {body}")
        job_id = body.get("id") or body.get("deployment", {}).get("id")
        note(f"created deployment {job_id} through the console API")
        return job_id

    def offer(self, data: bytes, filename: str) -> tuple[str, str]:
        """Make a job for the image in the way --via says. Returns (job id, version)."""
        version = image_version(data)
        sha256 = hashlib.sha256(data).hexdigest()
        if self.args.via == "api":
            self.release(data, filename)
            return self.deploy(version), version
        self.put_object(data, sha256)
        return self.bench_job(version, len(data), sha256), version

    def wait_taken_up(self, job_id: str) -> dict:
        """The board has done something about the job: it offers it, or it has started it. A shadow
        also says which job, and STATUS has no such line, so only what is there is compared."""
        return self.wait_status("the board to offer the update or to start it",
                                lambda s: (update_state(s) == "awaiting_user" or update_state(s) in UNDER_WAY)
                                and s.get("job", job_id) == job_id, 90, 1)

    def start_update(self, job_id: str) -> float | None:
        """Get the update going on whichever image runs. Returns when Button 1 was pressed, or None if
        the image started it by itself. A press that does nothing is a failure here: the console says OK
        to a press whatever becomes of it."""
        status = self.wait_taken_up(job_id)
        if update_state(status) != "awaiting_user":
            note(f"job {job_id}: the board started it with no button: {status['update']}")
            return None
        note(f"job {job_id}: the board offers it: {status['update']}")
        self.press(1)
        pressed = time.time()
        limit = PERSON_PRESS_SECONDS if self.by_a_person() else PRESS_SECONDS
        try:
            status = self.wait_status("Button 1 to start the update the board offered",
                                      lambda s: update_state(s) in UNDER_WAY, limit, 1)
        except TestFailed as error:
            if not self.by_a_person():
                raise
            # A press that comes later must not install what nobody is watching any more.
            self.cancel(job_id, False)
            raise TestFailed(f"nobody pressed Button 1 on the board within {limit} s, so job {job_id} "
                             f"was cancelled: {error}") from error
        note(f"the press started it: {status['update']}")
        return pressed

    def wait_offered(self, job_id: str) -> None:
        """For a scenario about the offer itself, which the image should make: see needs_an_offer()."""
        status = self.wait_taken_up(job_id)
        if update_state(status) != "awaiting_user":
            # It would install what it was only meant to offer.
            self.cancel(job_id, True)
            raise TestFailed(f"the board started the update with no offer: {status['update']}")
        note(f"board offers the update: {status['update']}")

    def needs_an_offer(self, firmware: str) -> None:
        """Before any job exists, because an image with no offer would install it."""
        if asks_for_button(firmware) or self.args.has_offer:
            return
        raise NotApplicable(f"the board runs {firmware}, which starts an update by itself, so it makes no "
                            "offer. This takes firmware older than "
                            f"{'.'.join(map(str, FIRST_WITH_NO_OFFER))}, or --has-offer on a build with "
                            "CONFIG_APP_OTA_REQUIRE_USER_CONSENT")

    def needs_a_console(self, why: str) -> None:
        """Before anything has been done, because the rest of it would show nothing."""
        if self.cloud_only:
            raise NotApplicable(f"{why}, and this run has no console")

    # ---- scenarios ----------------------------------------------------------------

    def update(self, path: Path) -> dict:
        data = path.read_bytes()
        before = self.wait_online()
        target = image_version(data)
        start = time.time()
        marks = {}
        job_id, _ = self.offer(data, path.name)
        pressed = self.start_update(job_id)
        began = pressed or start

        def follow():
            status = self.status()
            state = update_state(status) if status else "restarting"
            if state not in marks and state != "idle":
                marks[state] = time.time() - began
                note(f"board: {state} after {marks[state]:.0f} s")

        execution = self.wait_job(job_id, 900, follow)
        marks["total"] = time.time() - began
        if execution.get("status") != "SUCCEEDED":
            raise TestFailed(f"job ended {execution.get('status')}: {execution.get('statusDetails')}")
        status = self.wait_online()
        if status.get("firmware") != target:
            raise TestFailed(f"board runs {status.get('firmware')}, expected {target}")
        self.expect_confirmed(target)
        note(f"updated {before.get('firmware')} -> {target} in {marks['total']:.0f} s "
             f"after {'the button' if pressed else 'the job was created'}")
        return {"from": before.get("firmware"), "to": target, "job": job_id,
                "sha256": hashlib.sha256(data).hexdigest(),
                "seconds_from": "the button" if pressed else "the job",
                "seconds": {k: round(v) for k, v in marks.items()}}

    def expect_confirmed(self, target: str) -> None:
        reported = self.shadow()["fw"]
        if reported != {"version": target, "confirmed": True}:
            time.sleep(SHADOW_CATCH_UP_SECONDS)
            reported = self.shadow()["fw"]
            if reported != {"version": target, "confirmed": True}:
                raise TestFailed(f"shadow says {reported}, expected {target} confirmed")

    def expect_refusal(self, job_id: str, status_wanted: str, reason: str, running: str,
                       timeout: float = 600, follow=None) -> dict:
        execution = self.wait_job(job_id, timeout, follow)
        details = execution.get("statusDetails", {}).get("detailsMap", {})
        if execution.get("status") != status_wanted or details.get("reason") != reason:
            raise TestFailed(f"expected {status_wanted}/{reason}, got "
                             f"{execution.get('status')}/{details}")
        status = self.wait_online()
        if status.get("firmware") != running:
            raise TestFailed(f"board runs {status.get('firmware')}, expected {running} still")
        return {"job": job_id, "status": status_wanted, "reason": reason, "running": running}

    def expect_last(self, wanted: str) -> None:
        """What the console shows as the board's last result has to stay what happened,
        also after the replies that were still on their way have arrived."""
        time.sleep(6)
        last = self.shadow()["ota"]["last"]
        if last != wanted:
            raise TestFailed(f"the board reports its last result as {last}, expected {wanted}")

    def decline(self, path: Path) -> dict:
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        self.needs_an_offer(running)
        job_id, _ = self.offer(data, path.name)
        self.wait_offered(job_id)
        self.press(2)
        return self.expect_refusal(job_id, "REJECTED", "declined", running,
                                   PERSON_PRESS_SECONDS if self.by_a_person() else 60)

    def cancel(self, job_id: str, force: bool) -> None:
        if job_id.startswith("cranium-bench-"):
            arguments = ["iot", "cancel-job", "--job-id", job_id]
            if force:
                arguments.append("--force")
            self.aws.call(*arguments)
        else:
            status, body = self.api("POST", f"/api/deployments/{job_id}/cancel", {"force": force})
            if status not in (200, 202):
                raise TestFailed(f"cancellation answered {status}: {body}")
        note(f"cancelled {job_id}{' with force' if force else ''}")

    def cancel_offer(self, path: Path) -> dict:
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        self.needs_an_offer(running)
        job_id, _ = self.offer(data, path.name)
        self.wait_offered(job_id)
        self.cancel(job_id, False)
        status = self.wait_status("the offer to disappear",
                                  lambda s: s.get("update", "").startswith("idle"), 90)
        if status.get("firmware") != running:
            raise TestFailed(f"firmware changed to {status.get('firmware')}")
        return {"job": job_id, "last": status.get("update"), "running": running}

    def cancel_stop(self, path: Path) -> dict:
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        job_id, _ = self.offer(data, path.name)
        self.start_update(job_id)
        self.wait_status("the download to start",
                         lambda s: s.get("update", "").startswith("downloading"), 90, 1)
        time.sleep(6)
        self.cancel(job_id, True)
        mark = len(self.boot_lines)
        status = self.wait_status("the board to drop the update",
                                  lambda s: s.get("update", "").startswith("idle"), 240, 3)
        if status.get("firmware") != running:
            raise TestFailed(f"firmware changed to {status.get('firmware')}")
        uptime = status.get("uptime")
        time.sleep(30)
        status = self.wait_online()
        # With no bootloader log, an uptime that went back is what a restart looks like.
        restarted = (self.boot_log_has("Starting bootloader", mark) if not self.cloud_only
                     else uptime is not None and status.get("uptime", uptime) < uptime)
        if status.get("firmware") != running or restarted:
            raise TestFailed("the board restarted or changed firmware after the cancellation")
        return {"job": job_id, "last": status.get("update"), "running": running}

    def older(self, path: Path) -> dict:
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        version = image_version(data)
        sha256 = hashlib.sha256(data).hexdigest()
        self.put_object(data, sha256)
        job_id = self.bench_job(version, len(data), sha256)
        return self.expect_refusal(job_id, "REJECTED", "not_newer", running, 90)

    def corrupt(self, path: Path) -> dict:
        data = bytearray(path.read_bytes())
        running = self.wait_online()["firmware"]
        version = image_version(bytes(data))
        sha256 = hashlib.sha256(data).hexdigest()
        data[len(data) // 2] ^= 0x40
        damaged = hashlib.sha256(data).hexdigest()
        self.put_object(bytes(data), damaged)
        job_id = self.bench_job(version, len(data), sha256, damaged)
        self.start_update(job_id)
        return self.expect_refusal(job_id, "FAILED", "digest_mismatch", running, 420)

    def bad_signature(self, path: Path) -> dict:
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        version = image_version(data)
        hdr_size = int.from_bytes(data[8:10], "little")
        img_size = int.from_bytes(data[12:16], "little")
        tool = Path(os.environ["ZEPHYR_BASE"]).parent / "bootloader/mcuboot/scripts/imgtool.py"
        with tempfile.TemporaryDirectory() as folder:
            key, raw, signed = (Path(folder) / n for n in ("other.pem", "raw.bin", "signed.bin"))
            raw.write_bytes(data[hdr_size:hdr_size + img_size])
            subprocess.run([sys.executable, str(tool), "keygen", "-t", "ecdsa-p256", "-k", str(key)],
                           check=True, capture_output=True)
            subprocess.run([sys.executable, str(tool), "sign", "--key", str(key), "--version", version,
                            "--slot-size", "0xe4000", "--header-size", hex(hdr_size), "--pad-header",
                            "--align", "4", "--rom-fixed", "0x30000", str(raw), str(signed)],
                           check=True, capture_output=True)
            forged = signed.read_bytes()
        sha256 = hashlib.sha256(forged).hexdigest()
        self.put_object(forged, sha256)
        mark = len(self.boot_lines)
        job_id = self.bench_job(version, len(forged), sha256)
        self.start_update(job_id)
        result = self.expect_refusal(job_id, "FAILED", "not_installed", running, 600)
        self.expect_last("failed")
        if self.cloud_only:
            return result
        if not self.boot_log_has(r"(?i)not valid|invalid|signature|Image in the secondary", mark):
            raise TestFailed("the boot log does not show the bootloader refusing the image")
        result["bootloader"] = [line for line in list(self.boot_lines)[mark:]
                                if re.search(r"(?i)not valid|invalid|signature|secondary", line)][:6]
        return result

    def faulty(self, path: Path) -> dict:
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        target = image_version(data)
        sha256 = hashlib.sha256(data).hexdigest()
        self.put_object(data, sha256)
        mark = len(self.boot_lines)
        started = time.time()
        job_id = self.bench_job(target, len(data), sha256)
        self.start_update(job_id)
        result = self.expect_refusal(job_id, "FAILED", "rolled_back", running, 900)
        self.expect_last("rolled_back")
        if not self.cloud_only:
            if not self.boot_log_has(r"Swap type: test", mark):
                raise TestFailed("the boot log shows no trial swap")
            if not self.boot_log_has(r"Swap type: revert", mark):
                raise TestFailed("the boot log shows no revert")
        result["seconds"] = round(time.time() - started)
        return result

    def reset_download(self, path: Path) -> dict:
        self.needs_a_console("this resets the board through its reset pin, which takes the debug probe")
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        target = image_version(data)
        sha256 = hashlib.sha256(data).hexdigest()
        self.put_object(data, sha256)
        job_id = self.bench_job(target, len(data), sha256)
        self.start_update(job_id)
        self.wait_status("the download to start",
                         lambda s: s.get("update", "").startswith("downloading"), 90, 1)
        time.sleep(5)
        self.reset_board()
        return self.expect_refusal(job_id, "FAILED", "interrupted", running, 240)

    def reset_swap(self, path: Path) -> dict:
        self.needs_a_console("this watches the bootloader's log for the swap and resets the board through "
                             "its reset pin, which take the second serial port and the debug probe")
        data = path.read_bytes()
        self.wait_online()
        target = image_version(data)
        sha256 = hashlib.sha256(data).hexdigest()
        self.put_object(data, sha256)
        mark = len(self.boot_lines)
        job_id = self.bench_job(target, len(data), sha256)
        self.start_update(job_id)
        deadline = time.time() + 480
        while not self.boot_log_has(r"Swap type: test", mark):
            if time.time() > deadline:
                raise TestFailed("the bootloader never started the swap")
            time.sleep(0.2)
        time.sleep(6)
        self.reset_board()
        execution = self.wait_job(job_id, 480)
        if execution.get("status") != "SUCCEEDED":
            raise TestFailed(f"job ended {execution.get('status')}: {execution.get('statusDetails')}")
        status = self.wait_online()
        if status.get("firmware") != target:
            raise TestFailed(f"board runs {status.get('firmware')}, expected {target}")
        return {"job": job_id, "running": target}

    def recovery(self, path: Path) -> dict:
        self.needs_a_console("this sends an image over the board's serial port")
        target = image_version(path.read_bytes())
        data = path.read_bytes()
        hdr_size = int.from_bytes(data[8:10], "little")
        img_size = int.from_bytes(data[12:16], "little")
        tool = Path(os.environ["ZEPHYR_BASE"]).parent / "bootloader/mcuboot/scripts/imgtool.py"
        console_device = self.console.port
        self.console.serial.close()
        recover = [sys.executable, str(REPO / "tools" / "recover.py"), "--port", console_device]
        results = {}
        try:
            with tempfile.TemporaryDirectory() as folder:
                key, raw, forged = (Path(folder) / n for n in ("other.pem", "raw.bin", "forged.bin"))
                raw.write_bytes(data[hdr_size:hdr_size + img_size])
                subprocess.run([sys.executable, str(tool), "keygen", "-t", "ecdsa-p256", "-k", str(key)],
                               check=True, capture_output=True)
                subprocess.run([sys.executable, str(tool), "sign", "--key", str(key), "--version", target,
                                "--slot-size", "0xe4000", "--header-size", hex(hdr_size), "--pad-header",
                                "--align", "4", "--rom-fixed", "0x30000", str(raw), str(forged)],
                               check=True, capture_output=True)
                mark = len(self.boot_lines)
                note("sending an image signed with another key through serial recovery")
                subprocess.run(recover + ["--reset", "upload", str(forged)], check=True, text=True)
                time.sleep(4)
                refused = [line for line in list(self.boot_lines)[mark:]
                           if re.search(r"(?i)not valid|invalid|Unable to find bootable|signature", line)]
                if not refused:
                    raise TestFailed("the bootloader did not refuse the badly signed image")
                note(f"refused: {refused[0]}")
                results["refused"] = refused[:4]
            note("sending the correctly signed image")
            mark = len(self.boot_lines)
            subprocess.run(recover + ["upload", str(path)], check=True, text=True)
            results["installed"] = target
        finally:
            self.console = BenchConsole(console_device, self.out / "vcom1-app.log",
                                        self.on_console_line)
        # The board has been off the network for minutes, and a phone's hotspot may have
        # stopped being visible in that time.
        status = self.wait_online(600)
        if status.get("firmware") != target:
            raise TestFailed(f"board runs {status.get('firmware')}, expected {target}")
        return results

    def trial_behind(self, target: str, sha256: str) -> dict:
        """The run of `update` that confirmed exactly this file through a real trial. Serial
        recovery leaves no trailer, so an image from there cannot revert, and "it did not revert"
        would then be true of the worst firmware there is."""
        path = self.out / "results.jsonl"
        lines = path.read_text().splitlines() if path.exists() else []
        for record in map(json.loads, reversed(lines)):
            result = record.get("result") or {}
            if (record.get("scenario") == "update" and record.get("outcome") == "PASS"
                    and result.get("to") == target and result.get("sha256") == sha256):
                return record
        raise NotRun(f"no run of `update` in {path} confirmed this image through an over-the-air "
                     "trial, so the check that it was not reverted would show nothing. Run "
                     "`ota_bench.py update` with it first, with the same --out")

    def wait_for_stuck_line(self, since: int, boot_since: int, timeout: float) -> None:
        """Only reads. Anything sent now would go to the main loop, and into the Wi-Fi stack."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if any(STUCK_RESTART.match(line) for _, line in self.console_log[since:]):
                return
            if self.boot_log_has(BOOTLOADER_STARTED, boot_since):
                raise TestFailed("the board restarted without saying why: the watchdog, or a crash")
            time.sleep(0.2)
        raise TestFailed(f"no [STUCK] line in {timeout:.0f} s, with the chip's power stopped")

    def wait_for_log(self, pattern: re.Pattern, since: int, timeout: float) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if any(pattern.match(line) for _, line in self.console_log[since:]):
                return
            time.sleep(0.2)
        raise TestFailed(f"no line like {pattern.pattern} in {timeout:.0f} s")

    def chip_dead(self, path: Path) -> dict:
        self.needs_a_console("this stops the chip with a console command and watches both serial ports. "
                             "chip-dead-cloud does this with no cable")
        data = path.read_bytes()
        target = image_version(data)
        trial = self.trial_behind(target, hashlib.sha256(data).hexdigest())
        before = self.wait_online()
        if before.get("firmware") != target:
            raise NotRun(f"the board runs {before.get('firmware')}, not {target}")
        count_before = int(before.get("stuck count", "-1"))
        if count_before != 0:
            raise NotRun(f"the board's stuck count is {count_before}, and a back-off would move the "
                         "limit: leave it on the cloud for 30 minutes, which clears it")
        self.expect_confirmed(target)

        trial_text = (f"an over-the-air trial confirmed this image in the run of {trial['at']}, so "
                      "it can revert, and a revert would show")
        note(f"the check that nothing was reverted means something here: {trial_text}")

        boot_mark = len(self.boot_lines)
        line_mark = len(self.console_log)
        final = self.console.exchange(DEAD_COMMAND)[1]
        started = time.time()
        if not final.startswith("OK "):
            raise TestFailed(f"{DEAD_COMMAND} answered: {final}")
        note("the chip's power has stopped. Nothing goes to the console until the board restarts")

        try:
            self.wait_for_stuck_line(line_mark, boot_mark, CHIP_DEAD_WAIT_SECONDS)
            # Everything the board says from here on is read, and it is not asked anything yet.
            self.wait_for_log(STUCK_AT_BOOT, line_mark, BOOT_SECONDS)
            self.wait_for_log(WIFI_CONNECTED, line_mark, 600)
        except TestFailed:
            self.rescue()
            raise

        status = self.wait_online()
        verdict = judge_stuck_restart(self.console_log[line_mark:],
                                      list(self.boot_lines)[boot_mark:], started, count_before)
        stats = "\n".join(self.console.run("STATS"))
        reset = RESET_LINE.search(stats)
        if reset is None or reset.group(1) != "software":
            raise TestFailed(f"the last reset was by {reset.group(1) if reset else 'nothing it says'}, "
                             "and it should be software")
        if status.get("firmware") != target:
            raise TestFailed(f"the board runs {status.get('firmware')}, expected {target}: reverted")
        self.expect_confirmed(target)
        note(f"{verdict['reason']} fired after {verdict['fired_after']} s: not reverted, and {trial_text}")
        return verdict | {"reset": "software", "firmware": target, "no_revert_means": trial_text,
                          "trial_job": trial["result"].get("job")}


    # ---- the same with no cable --------------------------------------------------------

    def wait_heartbeats_stop(self, since: float, timeout: float) -> dict:
        """The last status before they stopped. Going quiet is what is expected, so it is no failure,
        and a restart with no such gap is: nothing has stopped the chip then."""
        last = None
        deadline = since + timeout
        while time.time() < deadline:
            status = self.status()
            if status and status.get("uptime") is not None:
                if last and status["uptime"] < last["uptime"]:
                    raise TestFailed(f"the board restarted without going quiet, after {last['uptime']} s "
                                     "of uptime: that is a watchdog or a crash, and not these timers")
                last = status
                if (status.get("heartbeat age") or 0) >= ONLINE_SECONDS:
                    return status
            time.sleep(5)
        raise TestFailed(f"heartbeats went on for {timeout:.0f} s after the confirmation: was this image "
                         "built with CONFIG_APP_TEST_WIFI_DEAD_AFTER_SECONDS?")

    def wait_back(self, quiet: dict, timeout: float) -> dict:
        """The first report after the board went quiet, which has to be from a restart."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            status = self.status()
            if status and status.get("heartbeat") and status["heartbeat"] > quiet["heartbeat"]:
                if status["uptime"] >= quiet["uptime"]:
                    raise TestFailed(f"heartbeats came back with no restart, at {status['uptime']} s of "
                                     "uptime: the chip's power was never stopped, or the fault is not this")
                return status
            time.sleep(5)
        raise TestFailed(f"the board did not come back in {timeout:.0f} s after its last heartbeat")

    def chip_dead_cloud(self, path: Path) -> dict:
        data = path.read_bytes()
        target = image_version(data)
        before = self.wait_online()
        if before.get("firmware") == target:
            raise NotRun(f"the board runs {target} already, and this fires once per install: it takes "
                         "a version that the board does not run yet")
        installed = self.update(path)
        confirmed_at = time.time()
        note(f"{target} was confirmed through a real trial, so a revert would show. It should stop the "
             f"chip about {SELF_FIRE_SECONDS} s from now")

        quiet = self.wait_heartbeats_stop(confirmed_at, SELF_FIRE_SECONDS + SELF_FIRE_SLACK_SECONDS)
        note(f"heartbeats have stopped: the last was at {quiet['uptime']} s of uptime, "
             f"{quiet['heartbeat'] - confirmed_at:.0f} s after the confirmation")
        back = self.wait_back(quiet, CHIP_DEAD_WAIT_SECONDS + BACK_ON_CLOUD_SECONDS)
        gap = back["heartbeat"] - quiet["heartbeat"]
        note(f"it is back after {gap:.0f} s: uptime {back['uptime']} s, firmware {back.get('firmware')}, "
             f"stuck count {back.get('stuck count')}, reason {back.get('stuck reason')}")

        if back.get("firmware") != target or back.get("confirmed") is not True:
            raise TestFailed(f"the board runs {back.get('firmware')}, confirmed {back.get('confirmed')}, and "
                             f"it should run {target}, confirmed: reverted")
        if back.get("stuck reason") not in ("no_cloud", "wifi_silent") or not back.get("stuck count"):
            raise TestFailed(f"it restarted, and its report gives reason {back.get('stuck reason')}, count "
                             f"{back.get('stuck count')}: these timers did not do that, so it was the "
                             "watchdog or a crash")

        # Once per install: this long again, and it stays up. Its uptime only goes one way.
        uptime = back["uptime"]
        deadline = time.time() + SELF_FIRE_SECONDS + SELF_FIRE_SLACK_SECONDS
        while time.time() < deadline:
            status = self.status()
            if status and status.get("uptime") is not None:
                if status["uptime"] < uptime or status.get("cloud") != "connected":
                    raise TestFailed(f"it went quiet or restarted again, at {uptime} s of uptime: this is "
                                     "to fire once per install")
                uptime = status["uptime"]
            time.sleep(15)

        return {"from": before.get("firmware"), "to": target, "job": installed.get("job"),
                "sha256": installed.get("sha256"), "reason": back["stuck reason"],
                "count": back["stuck count"], "quiet_for_seconds": round(gap),
                "last_uptime": quiet["uptime"], "uptime_at_return": back["uptime"], "fired_once": True,
                "firmware": target, "no_revert_means": "an over-the-air trial confirmed this image in this run"}


SCENARIOS = {
    "chip-dead-cloud": Bench.chip_dead_cloud,
    "decline": Bench.decline, "cancel-offer": Bench.cancel_offer, "cancel-stop": Bench.cancel_stop,
    "older": Bench.older, "corrupt": Bench.corrupt, "bad-signature": Bench.bad_signature,
    "faulty": Bench.faulty, "reset-download": Bench.reset_download, "reset-swap": Bench.reset_swap,
    "recovery": Bench.recovery, "chip-dead": Bench.chip_dead,
}


def run(bench: Bench, name: str, function, path: Path) -> bool:
    note(f"=== {name} {path.name}")
    started = time.time()
    record = {"scenario": name, "image": path.name, "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "mode": "cloud-only" if bench.cloud_only else "console"}
    try:
        record["result"] = function(bench, path)
        record["outcome"] = "PASS"
        if bench.cloud_only:
            record["result"]["evidence"] = CLOUD_ONLY_SAYS
    except NotRun as reason:
        record["outcome"] = "NOT_RUN"
        record["error"] = str(reason)
    except NotApplicable as reason:
        record["outcome"] = "NOT_APPLICABLE"
        record["reason"] = str(reason)
    except ChipStuck as error:
        record["outcome"] = "FAIL"
        record["error"] = str(error) + hang_context(bench.status())
        record["chip_stuck"] = True
        bench.rescue()
    except (TestFailed, BoardError, subprocess.CalledProcessError) as error:
        record["outcome"] = "FAIL"
        record["error"] = str(error)
    # What the board or a command said. Not the record's own fields: a short name would ruin them.
    for key in ("error", "reason", "result"):
        if key in record:
            record[key] = bench.safe_for_results(record[key])
    record["duration"] = round(time.time() - started)
    with open(bench.out / "results.jsonl", "a") as file:
        file.write(json.dumps(record) + "\n")
    said = record.get("error") or record.get("reason")
    note(f"=== {record['outcome']} {name} {path.name} ({record['duration']} s)"
         + (f": {said}" if said else ""))
    bench.chip_stuck = bool(record.get("chip_stuck"))
    bench.last_outcome = record["outcome"]
    return record["outcome"] == "PASS"


def run_all(bench: Bench, args, function) -> int:
    """Every image in turn. Returns the exit status: see the top of this file."""
    failures = 0
    not_applicable = 0
    for path in args.images:
        if run(bench, args.command, function, path):
            continue
        if bench.last_outcome == "NOT_APPLICABLE":
            not_applicable += 1
            continue
        failures += 1
        # The next image would only find the same chip: this is not its fault.
        if args.stop_on_failure or bench.chip_stuck:
            break
    passed = len(args.images) - failures - not_applicable
    note(f"{passed} of {len(args.images)} passed"
         + (f", {not_applicable} not applicable" if not_applicable else ""))
    if failures:
        return 1
    return EXIT_NOT_APPLICABLE if not_applicable and not passed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["status", "update", *SCENARIOS])
    parser.add_argument("images", nargs="*", type=Path)
    parser.add_argument("--via", choices=["api", "direct"], default="api",
                        help="how update, decline and the cancel scenarios create their job")
    parser.add_argument("--as", dest="as_user", help="the release manager to act as in the API")
    parser.add_argument("--out", default=str(REPO / "build-hil"), help="where logs and results go")
    parser.add_argument("--real-button", action="store_true",
                        help="if the image that runs asks for the button, wait for a person to press "
                             "it instead of using the console's BUTTON command")
    parser.add_argument("--has-offer", action="store_true",
                        help="the image that runs is 1.7.2 or newer and was built with "
                             "CONFIG_APP_OTA_REQUIRE_USER_CONSENT, so decline and cancel-offer apply")
    parser.add_argument("--cloud-only", action="store_true",
                        help="use no serial port and no probe, even if a console is found: follow the "
                             "board through the job and the shadow, which is what happens with no console")
    parser.add_argument("--thing", help="the board's thing name, for when there is no console to ask")
    parser.add_argument("--serial-number", default="001050797470")
    parser.add_argument("--stop-on-failure", action="store_true")
    args = parser.parse_args()
    # Through the API, a release goes into the activity log in somebody's name: say whose.
    if args.via == "api" and args.as_user is None and args.command not in ("status", "chip-dead"):
        parser.error("--via api acts as a release manager: name one with --as <email>")
    if args.command == "chip-dead" and len(args.images) != 1:
        parser.error("chip-dead takes the one image that runs on the board")
    if args.command == "chip-dead-cloud":
        if len(args.images) != 1:
            parser.error("chip-dead-cloud takes the one image that it installs")
        args.cloud_only = True

    bench = Bench(args)
    try:
        if args.command == "status":
            if not bench.cloud_only:
                bench.wait_online(30)
            status = bench.status()
            if status is None:
                print("  the board's shadow could not be read")
                return 1
            for key, value in status.items():
                print(f"  {key:<14} {value}")
            print("  mode          ", "cloud-only" if bench.cloud_only else "console")
            print("  shadow        ", json.dumps(bench.shadow()))
            return 0
        function = Bench.update if args.command == "update" else SCENARIOS[args.command]
        if not args.images:
            parser.error("this command needs an image")
        return run_all(bench, args, function)
    finally:
        bench.close()


if __name__ == "__main__":
    sys.exit(main())
