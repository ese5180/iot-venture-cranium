#!/usr/bin/env python3
"""Hardware tests of the golden image: a real board on USB, and no Wi-Fi.

    python3 firmware/tests/hil/golden_bench.py plan              what each test does; touches nothing
    python3 firmware/tests/hil/golden_bench.py images            build the images the tests upload
    python3 firmware/tests/hil/golden_bench.py run G3 G4 G6      run these, in this order
    python3 firmware/tests/hil/golden_bench.py press --hold 7    hold Button 2 through a reset, once

The image under test is the frozen one (tools/golden.py). Until something is frozen, name a
scratch image with --golden-image, and flash a bootloader that pins it: `images` builds one.

The gesture needs a person's hand on Button 2, or this bench's stand-in for it:

    --gesture jlink   (default) nobody needed. The bench resets the board through the debug port,
                      stops at golden_gesture_follow(), where the bootloader has configured the
                      pin and not read it yet, and drives P1.09 low from the debug port. After the
                      hold time it lets go. Button 2 goes to ground and has a pull-up, so this
                      looks the same to the bootloader, which has no code for it. It needs the
                      ELF of the bootloader on the board (--mcuboot-elf), for that one address.
    --gesture person  the bench says what to do and waits for you.

What this stand-in cannot do: hold the button down into the application, because every stage of
the boot configures the pin again and that ends the drive. So with --gesture jlink, G5c does not
reach the code in ui.c that it is there for. G5f does, from the input driver on (--app-elf), and G5c
with --gesture person is the whole path. It has never seen a hand either: bounce, the RESET pin, and
anything that reads the pin before the bench drives it. G5e, a gesture from power-off, and pulling
USB (G5d, G11, with --power-cuts) need a person. G15 and G16 are the two that also need Wi-Fi and
AWS, because they do the gesture in the middle of a real update.

Everything both serial ports print goes to --out, with time stamps. A test ends with PASS, FAIL or
PARTIAL and appends one line to results.jsonl there. PARTIAL means that what it ran passed and that
a part the design asks for did not run: its line says which part, and the bench's exit code is not
0. Each line also names the image, the bootloader and the bench that produced it, and whether this
was a rehearsal: one does not qualify a frozen image.

Run from an nRF Connect SDK terminal for pyserial, cbor2, imgtool, nrfutil and west.
"""

import argparse
import hashlib
import json
import os
import pty
import re
import secrets  # noqa: F401  Before tools/ is on the path: tools/secrets.py would hide it.
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import tty
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import golden  # noqa: E402
import recover  # noqa: E402
from board import BoardError, Console, find_console_port, parse_key_values  # noqa: E402
import ota_bench  # noqa: E402
from ota_bench import LoggedPort, TestFailed, note  # noqa: E402
from serial.tools import list_ports  # noqa: E402

# Button 2. Checked against nrf5340_application.h and the board's devicetree by test_golden.py.
# P1's secure alias: the bootloader has not handed anything over to the non-secure side yet.
P1_SECURE_BASE = 0x50842800
GPIO_OUTCLR = 0x00c
GPIO_IN = 0x010
GPIO_DIRSET = 0x018
GPIO_DIRCLR = 0x01c
BUTTON_2_PIN = 9
BUTTON_2_MASK = 1 << BUTTON_2_PIN
GESTURE_SYMBOL = "golden_gesture_follow"
# In image_number_guard.c. Without it, a bootloader takes the image number it is sent as an index.
GUARD_SYMBOL = "flash_area_id_from_multi_image_slot_hook"
# LED1, and two more of the same port's registers.
LED_1_MASK = 1 << 6
GPIO_OUT = 0x004
GPIO_DIR = 0x014
JLINK_DEVICE = "nRF5340_xxAA_APP"

# Seconds the button is held, counted from the bootloader's first reading of it. These go with
# GOLDEN_ARMED_MS, GOLDEN_CANCEL_MS and GOLDEN_GIVE_UP_MS in golden_policy.h.
HOLD_TOO_SHORT = 2.0
HOLD_TO_FIRE = 7.0
HOLD_PAST_THE_WINDOW = 30.0
HOLD_GIVES_UP = 60.0
HOLD_INTO_THE_APPLICATION = 80.0

RESTORE_SECONDS = 300
# From Button 1 to the bootloader starting its swap: download included.
UPDATE_SECONDS = 480
# How far into a swap G16 goes. The whole swap takes about 81 s.
SWAP_RUNNING_SECONDS = 6
SEAL_SECONDS = 180
BOOT_SECONDS = 60
# Seconds after the bootloader says it started. Measured on the board, a restore takes 53 s: the
# primary slot is erased by 20 s, the secondary slot by 43 s, then the copy and a last check. A seal
# takes 36 s: its erase takes as long as the secondary slot's, 23 s, and then come the copy and the
# check. These land in each of those steps.
RESTORE_INTERRUPTED_AT = (2, 10, 25, 35, 44, 48, 51)
SEAL_INTERRUPTED_AT = (2, 10, 20, 28, 33)
POWER_CUT_AT = (2, 10, 30)
# How long a board's USB ports may take to come back after a power cut.
PORTS_BACK_SECONDS = 20
# How long the bootloader stays with LED1 after it logged what it decided: for its slow blinks.
LED_AFTER_THE_LOG_SECONDS = 5
# Slow blinks: TIMES_NOTHING and TIMES_REFUSED in golden.c, SLOW_BLINK_MS each.
BLINKS_NOTHING = 1
BLINKS_REFUSED = 3
SLOW_BLINK_SECONDS = 0.5
# Fast blinks while a release would fire: GOLDEN_BLINK_MS in golden_policy.h.
FAST_BLINK_SECONDS = 0.1
# Before this many seconds, restores cut off here are still erasing, on the board. See above.
RESTORE_STILL_ERASING_UNTIL = 40
# Image numbers an upload is refused for, which an unguarded build of this bootloader maps to the
# primary slot (1) and to the secondary slot (3). Numbers it maps to the bootloader's own partition,
# TF-M storage or the golden copy are not sent, whatever the bootloader is.
OTHER_IMAGE_NUMBERS = (1, 3)
OTHER_IMAGE_CHUNK = bytes(256)
# A test puts this in its result for a part of it that the design asks for and that did not run.
NOT_RUN = "not run"
BOOTLOADER_BYTES = 0x10000
PRIMARY_DAMAGE_ADDRESS = 0x00050000

# What the bootloader says. test_golden.py checks these against the strings in golden.c.
SAYS = {
    "fired": r"golden: gesture completed",
    "not_completed": r"golden: Button 2 let go too early or too late",
    "stuck": r"golden: Button 2 is still down",
    "restoring": r"golden: restoring the pinned image",
    "restored": r"golden: restored, restarting",
    "sealing": r"golden: sealing the running image",
    "sealed": r"golden: sealed, restarting",
    "nothing": r"golden: nothing to do",
    "refused": r"golden: refused",
}
WRITES = rf"{SAYS['restoring']}|{SAYS['sealing']}"
ANY_GOLDEN_LINE = r"golden:"
BOOTS_AN_IMAGE = r"Jumping to the first image slot"
PRIMARY_NOT_VALID = r"Image in the primary slot is not valid!"
IN_SERIAL_RECOVERY = r"Enter the serial recovery mode"
STARTED = r"Starting bootloader"


def elf_symbol(path: Path, name: str) -> int:
    """The address of a function in a 32-bit ELF, with the Thumb bit taken off."""
    data = path.read_bytes()
    if data[:5] != b"\x7fELF\x01":
        raise TestFailed(f"{path} is not a 32-bit ELF file")
    section_at, = struct.unpack_from("<I", data, 0x20)
    entry_size, count = struct.unpack_from("<HH", data, 0x2e)

    def section(index: int) -> tuple[int, int, int, int]:
        fields = struct.unpack_from("<10I", data, section_at + index * entry_size)
        return fields[1], fields[4], fields[5], fields[6]

    for index in range(count):
        kind, offset, size, link = section(index)
        if kind != 2:  # SHT_SYMTAB
            continue
        strings = section(link)[1]
        for symbol_at in range(offset, offset + size, 16):
            name_at, value = struct.unpack_from("<II", data, symbol_at)
            end = data.index(b"\0", strings + name_at)
            if data[strings + name_at:end].decode("ascii", "replace") == name:
                return value & ~1
    raise TestFailed(f"{path} has no {name}: is this a bootloader with the golden image built in?")


def intel_hex_bytes(text: str, below: int) -> dict[int, int]:
    """The bytes an Intel HEX file puts below this address, by address."""
    result = {}
    upper = 0
    for line in text.splitlines():
        if not line.startswith(":"):
            continue
        record = bytes.fromhex(line[1:])
        length, address, kind = record[0], (record[1] << 8) | record[2], record[3]
        if kind == 0:
            for index, value in enumerate(record[4:4 + length]):
                if upper + address + index < below:
                    result[upper + address + index] = value
        elif kind == 2:
            upper = int.from_bytes(record[4:6], "big") << 4
        elif kind == 4:
            upper = int.from_bytes(record[4:6], "big") << 16
    return result


def intel_hex_text(data: bytes) -> str:
    """Intel HEX of these bytes from address 0, without the erased flash at the end: nrfutil
    erases only the pages a file touches, and the bootloader's partition is below 64 KiB."""
    data = data.rstrip(b"\xff")
    lines = []
    for address in range(0, len(data), 16):
        record = bytes([len(data[address:address + 16]), address >> 8, address & 0xff, 0]) + data[address:address + 16]
        lines.append(f":{record.hex().upper()}{-sum(record) & 0xff:02X}")
    return "\n".join([*lines, ":00000001FF"]) + "\n"


def flipped(data: bytes, offset: int) -> bytes:
    copy = bytearray(data)
    copy[offset] &= copy[offset] - 1
    return bytes(copy)


def check_led(changes: list[tuple[float, str]], released_at: float, slow_blinks: int) -> dict:
    """What LED1's pin did in a gesture that was let go of at released_at, against the design:
    dark until 5 s, fast blinks until the release, then this many slow blinks. Changes are (seconds
    since the first reading of the button, what the pin is). Raises TestFailed if it is wrong."""
    armed = 5.0
    # The release takes GOLDEN_RELEASE_MS to count, and it keeps blinking until then.
    settled = released_at + 0.3
    if any(state == "lit" and at < armed - 0.2 for at, state in changes):
        raise TestFailed(f"LED1 was on before the gesture was armed: {changes[:6]}")
    fast = [at for at, _ in changes if armed - 0.2 <= at < released_at]
    expected = (released_at - armed) / FAST_BLINK_SECONDS
    if not expected * 0.8 <= len(fast) <= expected * 1.2:
        raise TestFailed(f"LED1 changed {len(fast)} times while armed, expected about {expected:.0f}")
    later = [change for change in changes if change[0] >= settled]
    ends = next((index for index, (_, state) in enumerate(later) if state == "not an output"), len(later))
    blinks = [later[index + 1][0] - at for index, (at, state) in enumerate(later[:ends])
              if state == "lit" and index + 1 < len(later)]
    if len(blinks) != slow_blinks or any(abs(lit - SLOW_BLINK_SECONDS) > 0.15 for lit in blinks):
        raise TestFailed(f"LED1 was lit for {blinks} after the release, expected {slow_blinks} times "
                         f"{SLOW_BLINK_SECONDS} s")
    return {"changes while armed": len(fast), "slow blinks": len(blinks)}


class LedWatch:
    """What the bootloader drives on LED1's pin, read through the debug port during a press. This
    is the pin's output latch and direction, not light: led0 is active high on this board."""

    def __init__(self, finished):
        self.finished = finished
        self.changes = []
        self.last = None
        self.started = None
        self.released_at = None

    def start(self) -> None:
        self.started = time.time()

    def sample(self, jlink: "JLink") -> None:
        out = jlink.read_word(P1_SECURE_BASE + GPIO_OUT) & LED_1_MASK
        output = jlink.read_word(P1_SECURE_BASE + GPIO_DIR) & LED_1_MASK
        state = ("lit" if out else "dark") if output else "not an output"
        if state != self.last:
            self.changes.append((round(time.time() - self.started, 2), state))
            self.last = state

    def for_seconds(self, jlink: "JLink", seconds: float) -> None:
        until = time.time() + seconds
        while time.time() < until:
            self.sample(jlink)

    def released(self, jlink: "JLink", timeout: float = 120) -> None:
        self.released_at = round(time.time() - self.started, 2)
        until = time.time() + timeout
        while not self.finished() and time.time() < until:
            self.sample(jlink)
        self.for_seconds(jlink, LED_AFTER_THE_LOG_SECONDS)


class JLink:
    """One session of SEGGER's J-Link Commander. It runs on a pseudo-terminal, as it does for a
    person, so that what it prints arrives when it prints it."""

    def __init__(self, executable: str, serial_number: str):
        master, slave = pty.openpty()
        tty.setraw(slave)
        # Left to itself, Commander replaces the firmware of the probe when it connects, and the
        # board's serial ports are gone for as long as that takes. This command file runs before
        # it connects, and then it carries on taking commands from the terminal.
        with tempfile.TemporaryDirectory() as folder:
            start = Path(folder) / "start.jlink"
            start.write_text("exec DisableAutoUpdateFW\n")
            self.process = subprocess.Popen(
                [executable, "-NoGui", "1", "-USB", serial_number, "-Device", JLINK_DEVICE,
                 "-If", "SWD", "-Speed", "4000", "-AutoConnect", "1", "-CommandFile", str(start)],
                stdin=slave, stdout=slave, stderr=slave, close_fds=True)
            os.close(slave)
            self.master = master
            self.text = ""
            self.consumed = 0
            try:
                # Not its prompt, which it shows for the command file before it connects.
                self.wait_for(r"Cortex-M\d+ identified", 30)
            except TestFailed:
                self.close()
                raise

    def wait_for(self, pattern: str, timeout: float = 10) -> re.Match:
        """What the commander prints from here on, until this appears."""
        deadline = time.time() + timeout
        while True:
            match = re.compile(pattern).search(self.text, self.consumed)
            if match:
                self.consumed = match.end()
                return match
            remaining = deadline - time.time()
            if remaining <= 0 or self.process.poll() is not None:
                raise TestFailed(f"J-Link: no {pattern!r}. It said: {self.text[self.consumed:][-400:]!r}")
            ready, _, _ = select.select([self.master], [], [], min(remaining, 0.2))
            if ready:
                try:
                    self.text += os.read(self.master, 4096).decode("utf-8", "replace")
                except OSError:
                    continue

    def send(self, command: str) -> None:
        os.write(self.master, command.encode("ascii") + b"\n")

    def write_word(self, address: int, value: int) -> None:
        self.send(f"w4 {address:08X}, {value:08X}")

    def read_word(self, address: int) -> int:
        self.send(f"mem32 {address:08X}, 1")
        return int(self.wait_for(rf"{address:08X} = ([0-9A-Fa-f]{{8}})").group(1), 16)

    def save(self, path: Path, address: int, size: int) -> None:
        self.send(f"savebin {path}, {address:X}, {size:X}")
        self.wait_for(r"into file\.\.\.O\.K\.", 60)

    def close(self) -> None:
        """Ends the session and leaves the target as it is: running, if it was started."""
        try:
            self.send("exit")
            self.process.wait(timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            self.process.kill()
            self.process.wait()
        os.close(self.master)


class JLinkButton:
    """Button 2 held down from the debug port."""

    def __init__(self, executable: str, serial_number: str, elf: Path):
        self.executable = executable
        self.serial_number = serial_number
        self.use_elf(elf)

    def use_elf(self, elf: Path) -> None:
        self.stop_at = elf_symbol(elf, GESTURE_SYMBOL)

    def hold_through_reset(self, seconds: float, watch: LedWatch | None = None) -> None:
        jlink = JLink(self.executable, self.serial_number)
        pressed = False
        wait = time.sleep if watch is None else (lambda duration: watch.for_seconds(jlink, duration))
        try:
            jlink.send("r")
            jlink.send("IsHalted")
            jlink.wait_for(r"CPU is halted")
            jlink.send(f"SetBP {self.stop_at:08X} T H")
            handle = jlink.wait_for(r"Breakpoint set @ addr .*\(Handle = (\d+)\)").group(1)
            jlink.send("g")
            jlink.send("WaitHalt 10000")
            jlink.wait_for(r"CPU halted\.", 15)
            # The level first, so that the pin never drives high on its way to low.
            jlink.write_word(P1_SECURE_BASE + GPIO_OUTCLR, BUTTON_2_MASK)
            jlink.write_word(P1_SECURE_BASE + GPIO_DIRSET, BUTTON_2_MASK)
            pressed = True
            if jlink.read_word(P1_SECURE_BASE + GPIO_IN) & BUTTON_2_MASK:
                raise TestFailed("J-Link: P1.09 still reads high after driving it low")
            jlink.send(f"ClrBP {handle}")
            jlink.wait_for(r"Breakpoint cleared")
            jlink.send("g")
            note(f"Button 2 is down, for {seconds:g} s, through the debug port")
            if watch is not None:
                watch.start()
            if seconds >= HOLD_GIVES_UP:
                # The bootloader lets go of the pin itself after this, and after that the
                # registers belong to TF-M and the application: leave them alone.
                wait(seconds)
                pressed = False
                note("Button 2 is released: the bootloader gave up on it and let go of the pin")
                return
            wait(seconds)
            jlink.write_word(P1_SECURE_BASE + GPIO_DIRCLR, BUTTON_2_MASK)
            pressed = False
            if not jlink.read_word(P1_SECURE_BASE + GPIO_IN) & BUTTON_2_MASK:
                raise TestFailed("J-Link: P1.09 still reads low after letting go")
            note("Button 2 is released")
            if watch is not None:
                watch.released(jlink)
        finally:
            # After a failure as well: never leave the pin driven, or the CPU stopped.
            if pressed:
                jlink.write_word(P1_SECURE_BASE + GPIO_DIRCLR, BUTTON_2_MASK)
            jlink.send("g")
            jlink.close()


class PersonButton:
    """A person at the board."""

    def __init__(self, ask=input):
        self.ask = ask

    def use_elf(self, elf: Path) -> None:
        pass

    def hold_through_reset(self, seconds: float) -> None:
        if HOLD_TO_FIRE - 2 <= seconds <= HOLD_TO_FIRE + 2:
            last = "Keep holding for 5 s, until LED1 blinks fast, then let go within the next 5 s."
        else:
            last = f"Keep holding for {seconds:g} s, then let go."
        self.ask("DO THIS: press and hold RESET. Press and hold Button 2. Let go of RESET. "
                 f"{last}\nPress Enter when you have let go. ")

    def hold_through_power_on(self) -> None:
        self.ask("DO THIS: pull the USB cable. Press and hold Button 2. Plug the cable back in. Keep holding "
                 "for 5 s, until LED1 blinks fast, then let go within the next 5 s.\n"
                 "Press Enter when you have let go. ")

    def power_cut(self) -> None:
        self.ask("DO THIS: pull the USB cable now, and plug it back in after a few seconds. "
                 "Press Enter when it is back. ")


def scratch_checkout(folder: Path, image: Path) -> golden.Checkout:
    """A layout for an image that has not been frozen, so that a rehearsal runs the same code.
    It holds nothing that a freeze would commit, and it is not the repository."""
    data = image.read_bytes()
    parsed = golden.parse_image(data)
    golden.check_image_alone(parsed, len(data))
    checkout = golden.Checkout(folder)
    checkout.prj_conf.parent.mkdir(parents=True, exist_ok=True)
    checkout.prj_conf.write_text(golden.set_pin("CONFIG_CRANIUM_GOLDEN=n\n", parsed.hash_tlv, parsed.size))
    manifest = {"version": parsed.version, "file": image.name, "file_sha256": parsed.file_sha256,
                "hash_tlv": parsed.hash_tlv, "key_hash_tlv": parsed.key_hash_tlv, "size": parsed.size,
                "commit": "rehearsal", "sdk": "rehearsal", golden.QUALIFYING_RUN: None}
    checkout.manifest.parent.mkdir(parents=True, exist_ok=True)
    checkout.write_manifest(manifest)
    checkout.frozen.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(image, checkout.frozen_image(manifest))
    return checkout


class CloudJobs(ota_bench.Bench):
    """ota_bench's jobs on this bench's ports, for G15 and G16: a port has one owner."""

    def __init__(self, bench: "Bench"):
        self.bench = bench
        self.args = argparse.Namespace(real_button=False, serial_number=bench.args.serial_number)
        self.outputs = json.loads(ota_bench.OUTPUTS.read_text())
        self.region = self.outputs["Region"]
        self.bucket = self.outputs["FirmwareBucketName"]
        self.aws = ota_bench.Aws(os.environ.get("AWS_PROFILE", "cranium"), self.region)
        self.out = bench.out
        self.boot_lines = bench.boot_lines
        self.thing = None
        self.release_manager = None
        self.presign_role = None

    @property
    def console(self):
        # Going through serial recovery closes the port and opens it again.
        return self.bench.console


class Bench:
    def __init__(self, args):
        self.args = args
        self.out = Path(args.out)
        self.out.mkdir(parents=True, exist_ok=True)
        if args.golden_image:
            self.checkout = scratch_checkout(self.out / "rehearsal", args.golden_image)
            note(f"rehearsal: nothing is frozen, and {args.golden_image.name} stands in for it")
        else:
            self.checkout = golden.Checkout(REPO)
        self.manifest, self.image = golden.check(self.checkout)
        self.pin = self.manifest["hash_tlv"]
        self.version = self.manifest["version"]
        self.boot_lines = []
        self.console_lines = []
        self.made_button = None
        self.baseline_file = self.out / "baseline.json"
        self.open_ports()

    @property
    def button(self):
        """Made when it is first needed: G0 runs on a bootloader that has no gesture yet."""
        if self.made_button is None:
            if self.args.gesture == "person":
                self.made_button = PersonButton()
            elif not self.args.mcuboot_elf.exists():
                raise TestFailed(f"{self.args.mcuboot_elf} is missing: --gesture jlink needs the ELF "
                                 "of the bootloader on the board")
            else:
                self.made_button = JLinkButton(self.args.jlink, self.args.jlink_serial,
                                               self.args.mcuboot_elf)
        return self.made_button

    # ---- the board ----------------------------------------------------------------

    def open_ports(self) -> None:
        ports = sorted(p.device for p in list_ports.comports()
                       if p.vid == 0x1366 and "usbmodem" in p.device.lower())
        self.console_device = self.args.port or find_console_port()
        boot_device = next(p for p in ports if p != self.console_device)
        self.boot = LoggedPort(boot_device, self.out / "vcom0-boot.log", self.boot_lines.append)
        self.console_port = LoggedPort(self.console_device, self.out / "vcom1-app.log",
                                       self.console_lines.append)
        self.console = Console(self.console_device, self.console_port)

    def close_ports(self) -> None:
        self.boot.close()
        self.console_port.close()

    def open_ports_when_back(self) -> None:
        deadline = time.time() + PORTS_BACK_SECONDS
        while True:
            try:
                return self.open_ports()
            except (BoardError, StopIteration, OSError) as error:
                if time.time() >= deadline:
                    raise TestFailed(f"the board's ports did not come back: {error!r}") from error
                time.sleep(0.2)

    def close(self) -> None:
        self.close_ports()

    def mark(self) -> int:
        return len(self.boot_lines)

    def said(self, pattern: str, since: int) -> list[str]:
        return [line for line in self.boot_lines[since:] if re.search(pattern, line)]

    def wait_said(self, pattern: str, since: int, timeout: float) -> str:
        deadline = time.time() + timeout
        while time.time() < deadline:
            lines = self.said(pattern, since)
            if lines:
                return lines[0]
            time.sleep(0.2)
        raise TestFailed(f"the bootloader did not say {pattern!r} within {timeout:.0f} s. It said: "
                         f"{self.boot_lines[since:][-12:]}")

    def did_not_say(self, pattern: str, since: int) -> None:
        lines = self.said(pattern, since)
        if lines:
            raise TestFailed(f"the bootloader should not have said this: {lines[:3]}")

    def wait_console_said(self, text: str, since: int, timeout: float) -> str:
        """The application's own log, on the console's port."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            for line in self.console_lines[since:]:
                if text in line:
                    return line
            time.sleep(0.2)
        raise TestFailed(f"the application did not say {text!r} within {timeout:.0f} s")

    def nrfutil(self, *arguments: str) -> None:
        result = subprocess.run(["nrfutil", "device", *arguments, "--serial-number", self.args.serial_number],
                                capture_output=True, text=True)
        if result.returncode != 0:
            raise TestFailed(f"nrfutil {arguments[0]}: {(result.stderr or result.stdout).strip()[-300:]}")

    def reset_pin(self) -> None:
        self.nrfutil("reset", "--reset-kind", "RESET_PIN")

    def program_mcuboot(self, hex_file: Path) -> None:
        """Only the ranges in the file: the default would wipe TF-M storage and provisioning."""
        if not hex_file.exists():
            raise TestFailed(f"{hex_file} is missing")
        self.nrfutil("program", "--firmware", str(hex_file), "--options",
                     "chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ")
        self.reset_pin()
        note(f"programmed {hex_file}")

    def damage_primary_by_probe(self) -> None:
        self.nrfutil("write", "--address", f"0x{PRIMARY_DAMAGE_ADDRESS:08x}", "--value", "0x00000000")
        self.reset_pin()
        note(f"cleared the word at 0x{PRIMARY_DAMAGE_ADDRESS:x}, in the primary slot")

    def press(self, seconds: float) -> None:
        self.button.hold_through_reset(seconds)

    def press_watching_led(self, ends_with: str, slow_blinks: int) -> dict:
        """The gesture, with LED1's pin read all through it. Only the debug port can do that."""
        if self.args.gesture != "jlink":
            self.press(HOLD_TO_FIRE)
            answer = self.button.ask(f"Did LED1 blink fast from 5 s until you let go, and then blink slowly "
                                     f"{slow_blinks} time(s)? y or n: ")
            if answer.strip().lower() != "y":
                raise TestFailed("the person at the board did not see LED1 do what it should")
            return {"LED1": "seen by a person"}
        mark = self.mark()
        watch = LedWatch(lambda: self.said(ends_with, mark))
        self.button.hold_through_reset(HOLD_TO_FIRE, watch)
        return check_led(watch.changes, watch.released_at, slow_blinks)

    def status_up(self, timeout: float = BOOT_SECONDS) -> dict:
        deadline = time.time() + timeout
        while True:
            try:
                return self.console.status()
            except BoardError as error:
                if time.time() >= deadline:
                    raise TestFailed(f"the application did not answer in {timeout:.0f} s: {error}") from error
                time.sleep(1)

    def certs(self) -> dict:
        return parse_key_values(self.console.run("STATUS|certs"))

    def with_bootloader(self, action, leave_running: bool = True, reset: bool = True):
        """Serial recovery has the console's port: the bench gives it up for this long."""
        self.console_port.close()
        link = recover.Link(self.console_device)
        try:
            recover.enter(link, self.args.serial_number if reset else None, False,
                          recover.ENTER_THROUGH_A_SWAP)
            result = action(link)
            # A command makes the bootloader stay for good, until it is told to restart.
            if leave_running:
                link.request(recover.OP_WRITE, recover.GROUP_OS, recover.ID_OS_RESET, {})
            return result
        finally:
            link.close()
            self.console_port = LoggedPort(self.console_device, self.out / "vcom1-app.log",
                                           self.console_lines.append)
            self.console = Console(self.console_device, self.console_port)

    def listing(self) -> list[dict]:
        return self.with_bootloader(recover.show)

    def upload(self, data: bytes) -> None:
        """Through serial recovery with no check on this side: the bootloader has to refuse."""
        note(f"sending {len(data)} bytes through serial recovery")
        self.with_bootloader(lambda link: recover.upload(link, data))

    def upload_and_mark(self, data: bytes) -> int:
        """An upload, and where the bootloader's log had got to when the last of it was sent."""
        marks = []

        def send(link: recover.Link) -> None:
            recover.upload(link, data)
            marks.append(self.mark())

        note(f"sending {len(data)} bytes through serial recovery")
        self.with_bootloader(send)
        return marks[0]

    def restore_by_tool(self) -> None:
        """Layer 1: tools/golden.py restore."""
        self.console_port.close()
        try:
            golden.restore(self.checkout, None, self.console_device, self.args.serial_number, False)
        finally:
            self.console_port = LoggedPort(self.console_device, self.out / "vcom1-app.log",
                                           self.console_lines.append)
            self.console = Console(self.console_device, self.console_port)

    def expect_running(self, version: str) -> dict:
        status = self.status_up()
        if status.get("firmware") != version:
            raise TestFailed(f"the board runs {status.get('firmware')}, expected {version}")
        return status

    def baseline(self) -> dict | None:
        return json.loads(self.baseline_file.read_text()) if self.baseline_file.exists() else None

    def expect_golden_back(self) -> dict:
        """After a restore by the gesture: the pinned version runs, it is the same device, the
        bootloader lists the pin, and the secondary slot is empty."""
        status = self.expect_running(self.version)
        certs = self.certs()
        baseline = self.baseline()
        if baseline and status.get("thing name") != baseline["thing name"]:
            raise TestFailed(f"the thing name changed to {status.get('thing name')}")
        if baseline and certs != baseline["certs"]:
            raise TestFailed(f"the certificates changed: {certs}, was {baseline['certs']}")
        listed = self.listing()
        if not any(image["slot"] == 0 and image["hash"] == self.pin for image in listed):
            raise TestFailed(f"the bootloader lists {listed}, and the pin is {self.pin}")
        if any(image["slot"] != 0 for image in listed):
            raise TestFailed(f"the restore left an image in the secondary slot: {listed}")
        return {"firmware": status["firmware"], "certs": certs, "listed": listed}

    def gesture_restores(self) -> dict:
        mark = self.mark()
        started = time.time()
        self.press(HOLD_TO_FIRE)
        self.wait_said(SAYS["restoring"], mark, BOOT_SECONDS)
        self.wait_said(SAYS["restored"], mark, RESTORE_SECONDS)
        seconds = time.time() - started
        self.wait_said(BOOTS_AN_IMAGE, mark, BOOT_SECONDS)
        note(f"restored in {seconds:.0f} s, gesture included")
        result = self.expect_golden_back()
        result["seconds"] = round(seconds)
        return result

    def gesture_refused(self) -> str:
        mark = self.mark()
        self.press(HOLD_TO_FIRE)
        line = self.wait_said(SAYS["refused"], mark, BOOT_SECONDS)
        self.did_not_say(WRITES, mark)
        return line

    def gesture_seals(self) -> float:
        mark = self.mark()
        started = time.time()
        self.press(HOLD_TO_FIRE)
        self.wait_said(SAYS["sealing"], mark, BOOT_SECONDS)
        self.wait_said(SAYS["sealed"], mark, SEAL_SECONDS)
        seconds = time.time() - started
        self.wait_said(BOOTS_AN_IMAGE, mark, BOOT_SECONDS)
        return seconds

    def get_golden_running_and_sealed(self) -> None:
        """What most tests start from. A test image never has the golden image's version."""
        try:
            running = self.status_up(15).get("firmware")
        except TestFailed:
            running = None
        if running != self.version:
            self.restore_by_tool()
            self.expect_running(self.version)
        mark = self.mark()
        self.press(HOLD_TO_FIRE)
        self.wait_said(rf"{SAYS['sealed']}|{SAYS['nothing']}", mark, SEAL_SECONDS)
        self.wait_said(BOOTS_AN_IMAGE, mark, BOOT_SECONDS * 2)
        self.expect_running(self.version)

    # ---- the tests: the numbers are those of the design -------------------------------

    def g0(self) -> dict:
        status = self.status_up()
        record = {"thing name": status["thing name"], "firmware": status["firmware"],
                  "state": status.get("state"), "certs": self.certs(),
                  "saved": str(self.save_bootloader())}
        record["listed"] = self.listing()
        self.baseline_file.write_text(json.dumps(record, indent=2) + "\n")
        self.status_up()
        return record

    def save_bootloader(self) -> Path:
        """What the board holds, read from it: this is the way back, and a build directory may
        already hold something newer. Never over a copy that was saved earlier."""
        target = self.checkout.frozen / "mcuboot-before-golden.hex"
        if target.exists():
            note(f"{target} is there already, and it stays")
            return target
        with tempfile.TemporaryDirectory() as folder:
            read_back = Path(folder) / "mcuboot.bin"
            jlink = JLink(self.args.jlink, self.args.jlink_serial)
            try:
                jlink.save(read_back, 0, BOOTLOADER_BYTES)
            finally:
                jlink.send("g")
                jlink.close()
            data = read_back.read_bytes()
        if len(data) != BOOTLOADER_BYTES:
            raise TestFailed(f"read {len(data)} bytes of the bootloader, expected {BOOTLOADER_BYTES}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(intel_hex_text(data))
        note(f"saved the bootloader on the board as {target}, {len(data.rstrip(bytes([0xff])))} bytes")
        return target

    def g1(self) -> dict:
        # The system's compiler: the sanitizers the host tests use are not in the SDK's toolchain.
        compiler = os.environ.get("CC") or shutil.which("cc", path="/usr/bin") or "cc"
        commands = [["make", "-C", str(REPO / "firmware/tests/host"), f"CC={compiler}"]]
        for test in ("test_golden.py", "test_recover.py", "test_board.py"):
            commands.append([sys.executable, str(REPO / "firmware/tests/hil" / test)])
        for command in commands:
            result = subprocess.run(command, capture_output=True, text=True)
            if result.returncode != 0:
                raise TestFailed(f"{Path(command[-1]).name}: {(result.stdout + result.stderr)[-400:]}")
        return {"ran": len(commands)}

    def g2(self) -> dict:
        self.restore_by_tool()
        status = self.expect_running(self.version)

        offset = golden.flip_offsets(self.image)["body"]
        with tempfile.TemporaryDirectory() as folder:
            bad = Path(folder) / "flipped.bin"
            bad.write_bytes(flipped(self.image, offset))
            mark = self.mark()
            try:
                golden.restore(self.checkout, bad, self.console_device, self.args.serial_number, False)
            except golden.GoldenError as error:
                refusal = str(error)
            else:
                raise TestFailed("tools/golden.py sent a flipped file")
        time.sleep(3)
        self.did_not_say(STARTED, mark)
        return {"running": status["firmware"], "flipped file": refusal}

    def g3(self) -> dict:
        mark = self.mark()
        self.program_mcuboot(self.args.mcuboot_hex)
        self.wait_said(BOOTS_AN_IMAGE, mark, BOOT_SECONDS)
        self.did_not_say(ANY_GOLDEN_LINE, mark)
        status = self.status_up()
        if status.get("state") != "OPERATING":
            raise TestFailed(f"state is {status.get('state')}")
        certs = self.certs()
        if any(value != "set" for value in certs.values()):
            raise TestFailed(f"not every certificate is set: {certs}")
        listed = self.listing()
        self.status_up()
        size = len(intel_hex_bytes(self.args.mcuboot_hex.read_text(), BOOTLOADER_BYTES))
        return {"mcuboot bytes": size, "of": BOOTLOADER_BYTES, "state": status["state"], "certs": certs,
                "listed": listed}

    def g4(self) -> dict:
        self.expect_running(self.version)
        seconds = self.gesture_seals()
        self.expect_running(self.version)
        mark = self.mark()
        led = self.press_watching_led(SAYS["nothing"], BLINKS_NOTHING)
        self.wait_said(SAYS["nothing"], mark, BOOT_SECONDS)
        self.did_not_say(WRITES, mark)
        self.expect_running(self.version)
        return {"seal seconds": round(seconds), **led}

    def not_booted_yet(self, since: int) -> None:
        """Right after the release: the application must not start with the button down. A person
        says when they have let go by pressing Enter, which is too late to tell."""
        if self.args.gesture == "jlink":
            self.did_not_say(BOOTS_AN_IMAGE, since)

    def g5a(self) -> dict:
        mark = self.mark()
        self.press(HOLD_TOO_SHORT)
        self.not_booted_yet(mark)
        self.wait_said(SAYS["not_completed"], mark, 15)
        self.wait_said(BOOTS_AN_IMAGE, mark, BOOT_SECONDS)
        self.did_not_say(WRITES, mark)
        return {"status": self.status_up().get("state")}

    def g5b(self) -> dict:
        mark = self.mark()
        self.press(HOLD_PAST_THE_WINDOW)
        self.not_booted_yet(mark)
        self.wait_said(SAYS["not_completed"], mark, 15)
        self.wait_said(BOOTS_AN_IMAGE, mark, BOOT_SECONDS)
        self.did_not_say(WRITES, mark)
        return {"status": self.status_up().get("state")}

    def g5c(self) -> dict:
        before = self.certs()
        mark = self.mark()
        self.press(HOLD_INTO_THE_APPLICATION)
        self.wait_said(SAYS["stuck"], mark, 5)
        self.wait_said(BOOTS_AN_IMAGE, mark, BOOT_SECONDS)
        self.did_not_say(WRITES, mark)
        status = self.status_up()
        # A factory reset takes a moment after the release.
        time.sleep(5)
        status = self.status_up()
        after = self.certs()
        if status.get("state") != "OPERATING" or after != before:
            raise TestFailed(f"the board was wiped: state {status.get('state')}, certificates {after}")
        result = {"state": status["state"], "certs": after}
        if self.args.gesture == "jlink":
            result["ui.c"] = NOT_RUN
            result["limit"] = ("the debug port cannot hold the button into the application, so "
                               "this ran the 60 s path but not the check in ui.c: G5f does that")
        return result

    def g5e(self) -> dict:
        if self.args.gesture != "person":
            return {"gesture from power-off": NOT_RUN, "limit": "somebody has to pull the cable"}
        self.get_golden_running_and_sealed()
        self.damage_primary_by_probe()
        self.close_ports()
        self.button.hold_through_power_on()
        self.open_ports_when_back()
        # A restore takes the better part of a minute, so whatever the ports missed, this is proof.
        self.status_up(RESTORE_SECONDS)
        return self.expect_golden_back()

    def g5f(self) -> dict:
        if self.args.gesture != "jlink":
            return {"ui.c": NOT_RUN, "limit": "this needs the debug port: G5c with a person is the whole path"}
        before = self.certs()
        result = hold_into_the_input_driver(self.args.jlink, self.args.jlink_serial, self.args.app_elf)
        status = self.status_up()
        after = self.certs()
        if status.get("state") != "OPERATING" or after != before:
            raise TestFailed(f"the board was wiped: state {status.get('state')}, certificates {after}")
        return {**result, "state": status["state"], "certs": after}

    def g5d(self) -> dict:
        resets = 0
        mark = self.mark()
        for _ in range(10):
            before = self.mark()
            self.reset_pin()
            self.wait_said(BOOTS_AN_IMAGE, before, BOOT_SECONDS)
            resets += 1
        cuts = 0
        if self.args.power_cuts:
            for _ in range(10):
                self.cut_power()
                if self.what_runs_after_a_cut() != "an image that passed":
                    raise TestFailed("the board did not boot after a power cut")
                cuts += 1
        self.did_not_say(ANY_GOLDEN_LINE, mark)
        self.status_up()
        return {"resets": resets, "power cuts": cuts if self.args.power_cuts else NOT_RUN}

    def g6(self) -> dict:
        self.get_golden_running_and_sealed()
        mark = self.mark()
        said = len(self.console_lines)
        self.upload(self.fault_image("crash.bin"))
        self.wait_said(BOOTS_AN_IMAGE, mark, BOOT_SECONDS)
        # It says so on the application's console, and restarts for as long as it runs.
        crash = self.wait_console_said("crashing on purpose", said, BOOT_SECONDS)
        result = self.gesture_restores()
        result["crash"] = crash
        return result

    def g7(self) -> dict:
        self.get_golden_running_and_sealed()
        mark = self.mark()
        self.upload(self.fault_image("wreck.bin"))
        self.wait_said(PRIMARY_NOT_VALID, mark, BOOT_SECONDS)
        self.wait_said(IN_SERIAL_RECOVERY, mark, BOOT_SECONDS)
        listed = self.with_bootloader(recover.show, leave_running=False, reset=False)
        if listed:
            raise TestFailed(f"a wrecked board still lists {listed}")
        return self.gesture_restores()

    def g8(self) -> dict:
        self.get_golden_running_and_sealed()
        mark = self.mark()
        self.damage_primary_by_probe()
        self.wait_said(PRIMARY_NOT_VALID, mark, BOOT_SECONDS)
        return self.gesture_restores()

    def g9(self) -> dict:
        self.get_golden_running_and_sealed()
        self.program_mcuboot(self.args.wrongpin_hex)
        self.button.use_elf(self.args.wrongpin_elf)
        try:
            mark = self.mark()
            led = self.press_watching_led(SAYS["refused"], BLINKS_REFUSED)
            on_a_valid_primary = self.wait_said(SAYS["refused"], mark, BOOT_SECONDS)
            self.did_not_say(WRITES, mark)
            self.wait_said(BOOTS_AN_IMAGE, mark, BOOT_SECONDS)
            self.expect_running(self.version)
            self.damage_primary_by_probe()
            mark = self.mark()
            on_a_damaged_primary = self.gesture_refused()
            self.wait_said(IN_SERIAL_RECOVERY, mark, BOOT_SECONDS)
        finally:
            self.program_mcuboot(self.args.mcuboot_hex)
            self.button.use_elf(self.args.mcuboot_elf)
        result = self.gesture_restores()
        result.update({"valid primary": on_a_valid_primary, "damaged primary": on_a_damaged_primary, **led})
        return result

    def g10(self) -> dict:
        self.get_golden_running_and_sealed()
        result = {}
        for where in ("signature", "body"):
            said = len(self.console_lines)
            self.upload(self.fault_image(f"flip-{where}.bin"))
            self.wait_console_said("golden byte at", said, BOOT_SECONDS)
            result[where] = self.gesture_refused()
            self.status_up()
            self.restore_by_tool()
            self.expect_running(self.version)
            self.gesture_seals()
            self.expect_running(self.version)
        return result

    def g11(self) -> dict:
        self.get_golden_running_and_sealed()
        result = {"restore": [], "seal": []}

        # A valid image that is not the pin. The erase takes its trailer and then its header within
        # the first moments, so a second in it must not boot any more: if it were on trial, it would
        # have lost its revert and count as confirmed.
        data = self.args.forward_image.read_bytes()
        self.upload(data)
        self.expect_running(golden.parse_image(data).version)
        result["restore"].append(self.interrupted_restore(1, cut=False, damage=False))
        if result["restore"][0] != "serial recovery":
            raise TestFailed("a valid image still boots a second into a restore: the header was not "
                             "erased right after the trailer")

        for seconds in RESTORE_INTERRUPTED_AT:
            outcome = self.interrupted_restore(seconds, cut=False)
            result["restore"].append(outcome)
            if seconds < RESTORE_STILL_ERASING_UNTIL and outcome != "serial recovery":
                raise TestFailed(f"an image booted {seconds} s into a restore, with no copy made yet")
        if self.args.power_cuts:
            for seconds in POWER_CUT_AT:
                result["restore"].append(self.interrupted_restore(seconds, cut=True))
        else:
            result["power cuts"] = NOT_RUN

        # The golden copy has to be wrong for a seal to start. After that an interrupted seal
        # leaves it wrong, so one image is enough for all of them.
        said = len(self.console_lines)
        self.upload(self.fault_image("flip-body.bin"))
        self.wait_console_said("golden byte at", said, BOOT_SECONDS)
        self.restore_by_tool()
        self.expect_running(self.version)
        for seconds in SEAL_INTERRUPTED_AT:
            result["seal"].append(self.interrupted_seal(seconds, cut=False))
        if self.args.power_cuts:
            for seconds in POWER_CUT_AT:
                result["seal"].append(self.interrupted_seal(seconds, cut=True))
        self.gesture_seals()
        self.expect_running(self.version)
        return result

    def cut_power(self) -> None:
        """The ports go with the cable, so the bench lets go of them first."""
        self.close_ports()
        self.button.power_cut()
        self.open_ports_when_back()

    def gesture_restores_whatever_is_there(self) -> None:
        mark = self.mark()
        self.press(HOLD_TO_FIRE)
        self.wait_said(rf"{SAYS['restored']}|{SAYS['nothing']}", mark, RESTORE_SECONDS)
        self.wait_said(BOOTS_AN_IMAGE, mark, BOOT_SECONDS * 2)
        self.expect_running(self.version)

    def what_runs_now(self, mark: int) -> str:
        """After an interruption, an image runs only if it passed the boot's own check."""
        line = self.wait_said(rf"{BOOTS_AN_IMAGE}|{IN_SERIAL_RECOVERY}", mark, BOOT_SECONDS)
        return "an image that passed" if re.search(BOOTS_AN_IMAGE, line) else "serial recovery"

    def what_runs_after_a_cut(self) -> str:
        """The boot log goes by before USB is back, so this asks the board instead."""
        try:
            self.status_up()
            return "an image that passed"
        except TestFailed:
            # Raises if this is not listening either, which would be neither of the two outcomes.
            self.with_bootloader(recover.show, leave_running=False, reset=False)
            return "serial recovery"

    def interrupt(self, cut: bool) -> str:
        if cut:
            self.cut_power()
            return self.what_runs_after_a_cut()
        before = self.mark()
        self.reset_pin()
        return self.what_runs_now(before)

    def interrupted_restore(self, seconds: float, cut: bool, damage: bool = True) -> str:
        if damage:
            self.damage_primary_by_probe()
        mark = self.mark()
        self.press(HOLD_TO_FIRE)
        self.wait_said(SAYS["restoring"], mark, BOOT_SECONDS)
        time.sleep(seconds)
        outcome = self.interrupt(cut)
        note(f"a restore interrupted after {seconds} s: {outcome}")
        self.gesture_restores_whatever_is_there()
        return outcome

    def interrupted_seal(self, seconds: float, cut: bool) -> str:
        mark = self.mark()
        self.press(HOLD_TO_FIRE)
        self.wait_said(SAYS["sealing"], mark, BOOT_SECONDS)
        time.sleep(seconds)
        outcome = self.interrupt(cut)
        self.expect_running(self.version)
        note(f"a seal interrupted after {seconds} s: {outcome}")
        return outcome

    def g12(self) -> dict:
        self.get_golden_running_and_sealed()
        result = {}
        result["other key"] = self.refused_at_every_boot(self.signed_with_a_throwaway_key())
        offset = golden.flip_offsets(self.image)["body"]
        result["flipped golden"] = self.refused_at_every_boot(flipped(self.image, offset))
        self.restore_by_tool()
        self.expect_running(self.version)
        return result

    def refused_at_every_boot(self, data: bytes) -> list[str]:
        # From after the upload: what the bootloader said on the way in is about the image before it.
        mark = self.upload_and_mark(data)
        first = self.wait_said(PRIMARY_NOT_VALID, mark, BOOT_SECONDS)
        mark = self.mark()
        self.reset_pin()
        second = self.wait_said(PRIMARY_NOT_VALID, mark, BOOT_SECONDS)
        self.did_not_say(BOOTS_AN_IMAGE, mark)
        return [first, second]

    def signed_with_a_throwaway_key(self) -> bytes:
        tool = Path(os.environ["ZEPHYR_BASE"]).parent / "bootloader/mcuboot/scripts/imgtool.py"
        image = golden.parse_image(self.image)
        with tempfile.TemporaryDirectory() as folder:
            key, raw, signed = (Path(folder) / n for n in ("other.pem", "raw.bin", "signed.bin"))
            raw.write_bytes(self.image[image.header_size:image.header_size + 4096])
            subprocess.run([sys.executable, str(tool), "keygen", "-t", "ecdsa-p256", "-k", str(key)],
                           check=True, capture_output=True)
            subprocess.run([sys.executable, str(tool), "sign", "--key", str(key), "--version",
                            self.version, "--slot-size", "0xe4000", "--header-size",
                            hex(image.header_size), "--pad-header", "--align", "4", "--rom-fixed",
                            "0x30000", str(raw), str(signed)], check=True, capture_output=True)
            return signed.read_bytes()

    def g13(self) -> dict:
        self.get_golden_running_and_sealed()
        data = self.args.forward_image.read_bytes()
        forward = golden.parse_image(data).version
        self.upload(data)
        status = self.expect_running(forward)
        stats = "\n".join(self.console.run("STATS"))
        if forward.split("+")[0] not in stats:
            raise TestFailed(f"STATS does not show {forward}")
        result = self.gesture_restores()
        result["forward to"] = status["firmware"]
        return result

    def update_in_progress(self, image: Path) -> tuple[CloudJobs, str, str, int]:
        """A real update, from the golden image, up to the point where the bootloader starts its
        swap. Needs Wi-Fi and AWS, unlike the rest of this bench."""
        self.get_golden_running_and_sealed()
        cloud = CloudJobs(self)
        cloud.wait_online()
        data = image.read_bytes()
        target = ota_bench.image_version(data)
        sha256 = hashlib.sha256(data).hexdigest()
        cloud.put_object(data, sha256)
        job_id = cloud.bench_job(target, len(data), sha256)
        cloud.wait_offered(job_id)
        mark = self.mark()
        cloud.press(1)
        self.wait_said(r"Swap type: test", mark, UPDATE_SECONDS)
        return cloud, job_id, target, mark

    def update_did_not_succeed(self, cloud: CloudJobs, job_id: str) -> dict:
        execution = cloud.wait_job(job_id, UPDATE_SECONDS)
        if execution.get("status") == "SUCCEEDED":
            raise TestFailed(f"the update reports success, and golden runs: {execution}")
        return {"job": execution.get("status"),
                "reason": execution.get("statusDetails", {}).get("detailsMap", {}).get("reason")}

    def g15(self) -> dict:
        if not self.args.trial_image:
            raise TestFailed("G15 needs --trial-image: one that never confirms itself")
        cloud, job_id, target, _ = self.update_in_progress(self.args.trial_image)
        cloud.wait_status(f"{target} to run on trial", lambda s: s.get("firmware") == target, BOOT_SECONDS * 4)
        mark = self.mark()
        result = self.gesture_restores()
        self.did_not_say(r"Swap type: (test|revert)", mark)
        result.update(self.update_did_not_succeed(cloud, job_id))
        return result

    def g16(self) -> dict:
        cloud, job_id, _, _ = self.update_in_progress(self.args.forward_image)
        time.sleep(SWAP_RUNNING_SECONDS)
        mark = self.mark()
        result = self.gesture_restores()
        self.did_not_say(r"Swap type: (test|revert)", mark)
        result.update(self.update_did_not_succeed(cloud, job_id))
        return result

    def g14(self) -> dict:
        # Never on a bootloader without the guard: there these numbers select flash areas.
        elf_symbol(self.args.mcuboot_elf, GUARD_SYMBOL)
        self.get_golden_running_and_sealed()
        refusals = self.with_bootloader(upload_for_other_images)
        # The primary slot and the golden copy are as they were, and the bootloader says so.
        self.expect_running(self.version)
        mark = self.mark()
        self.press(HOLD_TO_FIRE)
        self.wait_said(SAYS["nothing"], mark, BOOT_SECONDS)
        self.did_not_say(WRITES, mark)
        self.expect_running(self.version)
        return {"refused": refusals}

    def fault_image(self, name: str) -> bytes:
        path = self.args.images / name
        if not path.exists():
            raise TestFailed(f"{path} is missing: `golden_bench.py images` builds it")
        return path.read_bytes()


def upload_for_other_images(link: recover.Link) -> dict:
    """The first chunk of an upload for each of OTHER_IMAGE_NUMBERS: each has to be refused."""
    refusals = {}
    for number in OTHER_IMAGE_NUMBERS:
        body = {"off": 0, "len": len(OTHER_IMAGE_CHUNK), "data": OTHER_IMAGE_CHUNK, "image": number}
        try:
            reply = link.request(recover.OP_WRITE, recover.GROUP_IMAGE, recover.ID_IMAGE_UPLOAD, body)
        except recover.NoAnswer:
            raise
        except BoardError as error:
            refusals[str(number)] = str(error)
        else:
            raise TestFailed(f"the bootloader took a chunk for image {number}: {reply}")
    return refusals


# ---- a button held down into the application, from the input driver on -----------------------

# Button 2, which is key 1 to the application.
INPUT_KEY_1 = 2
# The pin stays low for this long after the driver read it, with the CPU stopped and then running.
DRIVER_HOLD_STOPPED = 6
DRIVER_HOLD_RUNNING = 9
# A release that gets past the check in ui.c shows here within this time.
TRIPWIRE_SECONDS = 8


def objdump_tool() -> str:
    found = shutil.which("arm-zephyr-eabi-objdump")
    if found:
        return found
    return str(Path(os.environ.get("ZEPHYR_SDK_INSTALL_DIR", ""), "gnu/arm-zephyr-eabi/bin/arm-zephyr-eabi-objdump"))


def on_input_addresses(listing: str) -> dict:
    """From objdump's listing of on_input: the instruction after the check that a press was seen,
    which goes on to post the event, and the address of pressed_at[]."""
    lines = listing.splitlines()
    for index, line in enumerate(lines):
        if re.search(r"\bbeq(\.n)?\s+\w+ <on_input\+0x[0-9a-f]+>", line) and "orrs" in lines[index - 1]:
            literal = next((text for text in lines if ".word" in text), None)
            if literal is None or index + 1 >= len(lines):
                break
            return {"post": int(lines[index + 1].split(":")[0], 16), "pressed_at": int(literal.split()[-1], 16)}
    raise TestFailed("on_input has no check that a press was seen: is this an image with the fix in ui.c?")


def hold_into_the_input_driver(executable: str, serial_number: str, elf: Path) -> dict:
    """Button 2 already down when the application's input driver starts, then let go with more than
    5 s of uptime: the release ui.c has to ignore, and which would otherwise be a factory reset.

    This starts at the driver, so the bootloader and TF-M are not involved. It stops at the driver's
    second reading of the port, drives the pin low there, and lets go later. Tripwires, so that this
    cannot wipe the board: hardware breakpoints at factory_reset() and at the line of on_input() that
    posts the button event. If either is hit the CPU stays there, and the board is reset from there,
    with nothing erased."""
    if not elf.exists():
        raise TestFailed(f"{elf} is missing: --app-elf has to be the ELF of the image on the board")
    listing = subprocess.run([objdump_tool(), "-d", "--disassemble=on_input", str(elf)],
                             capture_output=True, text=True, check=True).stdout
    addresses = on_input_addresses(listing)
    driver_read = elf_symbol(elf, "gpio_nrfx_port_get_raw.lto_priv.0")
    on_input = elf_symbol(elf, "on_input")
    jlink = JLink(executable, serial_number)
    handles = {}

    def breakpoint_at(address: int) -> str:
        jlink.send(f"SetBP {address:08X} T H")
        return jlink.wait_for(r"Breakpoint set @ addr .*\(Handle = (\d+)\)").group(1)

    def clear(handle: str) -> None:
        jlink.send(f"ClrBP {handle}")
        jlink.wait_for(r"Breakpoint cleared")

    def stopped_within(seconds: float) -> bool:
        jlink.send(f"WaitHalt {int(seconds * 1000)}")
        return jlink.wait_for(r"CPU halted\.|Timeout", seconds + 10).group(0) == "CPU halted."

    def registers() -> tuple[int, int]:
        start = jlink.consumed
        jlink.send("regs")
        end = jlink.wait_for(r"FPSCR= [0-9A-F]{8}", 5).end()
        chunk = jlink.text[start:end]
        return (int(re.findall(r"PC = ([0-9A-F]{8})", chunk)[-1], 16),
                int(re.findall(r"R0 = ([0-9A-F]{8})", chunk)[-1], 16))

    try:
        jlink.send("r")
        jlink.send("IsHalted")
        jlink.wait_for(r"CPU is halted")
        init = breakpoint_at(elf_symbol(elf, "gpio_keys_init"))
        jlink.send("g")
        if not stopped_within(30):
            raise TestFailed("the application never reached gpio_keys_init")
        clear(init)
        handles["factory_reset"] = breakpoint_at(elf_symbol(elf, "factory_reset"))
        handles["post"] = breakpoint_at(addresses["post"])
        handles["on_input"] = breakpoint_at(on_input)
        read = breakpoint_at(driver_read)

        # The second reading in the driver's loop is Button 2's. If it were another pin's, the driver
        # would store "released", the release below would never be reported, and this would fail.
        for _ in range(2):
            jlink.send("g")
            if not stopped_within(10) or registers()[0] != driver_read:
                raise TestFailed("the driver's reading of the pin never came")
        clear(read)
        jlink.write_word(P1_SECURE_BASE + GPIO_OUTCLR, BUTTON_2_MASK)
        jlink.write_word(P1_SECURE_BASE + GPIO_DIRSET, BUTTON_2_MASK)
        if jlink.read_word(P1_SECURE_BASE + GPIO_IN) & BUTTON_2_MASK:
            raise TestFailed("J-Link: P1.09 still reads high after driving it low")
        started = time.time()
        # The uptime goes on while the CPU is stopped, so this is past the 5 s of a long press.
        time.sleep(DRIVER_HOLD_STOPPED)
        jlink.send("g")
        # An early stop here means that the pin came up by itself when the interrupt was set up.
        early = stopped_within(DRIVER_HOLD_RUNNING)
        if not early:
            jlink.write_word(P1_SECURE_BASE + GPIO_DIRCLR, BUTTON_2_MASK)
            if not stopped_within(5):
                raise TestFailed("the release never reached on_input()")
        pc, r0 = registers()
        if pc != on_input:
            raise TestFailed(f"TRIPWIRE: stopped at {pc:#x}, not on_input()")
        event = jlink.read_word(r0 + 4)
        value = jlink.read_word(r0 + 8)
        pressed_at = (jlink.read_word(addresses["pressed_at"] + 8), jlink.read_word(addresses["pressed_at"] + 12))
        result = {"event code": event >> 16, "event value": value, "pressed_at[1]": list(pressed_at),
                  "seconds held": round(time.time() - started, 1), "pin stayed low until the release": not early}
        if event >> 16 != INPUT_KEY_1 or value != 0 or pressed_at != (0, 0):
            raise TestFailed(f"this is not the release with no press seen: {result}")
        clear(handles.pop("on_input"))
        jlink.send("g")
        if stopped_within(TRIPWIRE_SECONDS):
            raise TestFailed(f"TRIPWIRE: stopped at {registers()[0]:#x}: the release was not ignored")
        return result
    except Exception:
        # Whatever happened, nothing runs on from a tripwire.
        jlink.write_word(P1_SECURE_BASE + GPIO_DIRCLR, BUTTON_2_MASK)
        jlink.send("r")
        time.sleep(0.5)
        raise
    finally:
        for handle in handles.values():
            jlink.send(f"ClrBP {handle}")
            time.sleep(0.1)
        jlink.send("g")
        jlink.close()


# Name, what it needs, what it does: in the order of the design.
TESTS = {
    "G0": (Bench.g0, "the board as it is now", "record the device, and read the bootloader back"),
    "G1": (Bench.g1, "nothing", "the host tests and the tools' tests"),
    "G2": (Bench.g2, "the board", "layer 1: the tool restores, and refuses a flipped file"),
    "G3": (Bench.g3, "G0", "flash the new bootloader only: everything else as it was"),
    "G4": (Bench.g4, "G2, G3", "seal with golden running, then a repeat does nothing"),
    "G5a": (Bench.g5a, "G3", "Button 2 for 2 s through a reset: a normal boot"),
    "G5b": (Bench.g5b, "G3", "held past 10 s, let go at 30 s: no action, boots after the release"),
    "G5c": (Bench.g5c, "G3", "held past 60 s into the application: no factory reset"),
    "G5d": (Bench.g5d, "G3", "resets, and with --power-cuts power cuts: nothing about golden"),
    "G5e": (Bench.g5e, "G3, a person", "the gesture from power-off: restores"),
    "G5f": (Bench.g5f, "G3, --app-elf, --gesture jlink", "held from the input driver on: no factory reset"),
    "G6": (Bench.g6, "G3, crash.bin", "a confirmed image goes bad: the gesture restores"),
    "G7": (Bench.g7, "G3, wreck.bin", "both slots damaged: serial recovery, the gesture restores"),
    "G8": (Bench.g8, "G3", "the primary damaged by probe: the gesture restores"),
    "G9": (Bench.g9, "G3, the wrong-pin bootloader", "validly signed, not the pin: refused"),
    "G10": (Bench.g10, "G3, flip-*.bin", "tampered golden, in the signature and the body: refused"),
    "G11": (Bench.g11, "G3, flip-body.bin", "interrupted: never a partial image, a repeat finishes"),
    "G12": (Bench.g12, "G3", "another key and a flipped golden, with no tool in the way: refused"),
    "G13": (Bench.g13, "G3, --forward-image", "forward from golden, and the gesture still restores"),
    "G14": (Bench.g14, "G3", "an upload for another image number: refused, and nothing changed"),
    "G15": (Bench.g15, "G3, --trial-image, Wi-Fi, AWS", "the gesture during an update's trial: golden, no revert"),
    "G16": (Bench.g16, "G3, --forward-image, Wi-Fi, AWS", "the gesture during an update's swap: golden, no resume"),
}


def file_sha256(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def git_state() -> dict:
    """Which sources are running this, as a person would want to know later."""
    def git(*arguments: str) -> str:
        result = subprocess.run(["git", "-C", str(REPO), *arguments], capture_output=True, text=True)
        return result.stdout.strip() if result.returncode == 0 else "unknown"

    return {"commit": git("rev-parse", "--short", "HEAD"),
            "dirty": git("status", "--porcelain", "firmware", "tools") != ""}


def what_ran(bench: Bench) -> dict:
    """Ties a result to what produced it. A rehearsal, on a scratch image, qualifies nothing."""
    return {"rehearsal": bench.manifest["commit"] == "rehearsal",
            "image sha256": bench.manifest["file_sha256"],
            "mcuboot sha256": file_sha256(Path(bench.args.mcuboot_hex)),
            "bench sha256": file_sha256(Path(__file__)),
            **git_state()}


def run_test(bench: Bench, name: str) -> str:
    """The outcome: PASS, PARTIAL or FAIL."""
    note(f"=== {name} {TESTS[name][2]}")
    started = time.time()
    record = {"test": name, "gesture": bench.args.gesture, "image": bench.version,
              "at": time.strftime("%Y-%m-%dT%H:%M:%S"), **what_ran(bench)}
    try:
        record["result"] = TESTS[name][0](bench)
        skipped = [part for part, value in record["result"].items() if value == NOT_RUN]
        record["outcome"] = "PARTIAL" if skipped else "PASS"
        if skipped:
            record["not run"] = skipped
    except (TestFailed, BoardError, golden.GoldenError, subprocess.CalledProcessError, OSError) as error:
        record["outcome"] = "FAIL"
        record["error"] = str(error)
    record["duration"] = round(time.time() - started)
    with open(bench.out / "results.jsonl", "a") as file:
        file.write(json.dumps(record) + "\n")
    note(f"=== {record['outcome']} {name} ({record['duration']} s)"
         + (f": {record['error']}" if "error" in record else "")
         + (f": not run: {record['not run']}" if "not run" in record else ""))
    return record["outcome"]


def show_plan() -> None:
    print(f"{'test':<5} {'needs':<30} what it does")
    for name, (_, needs, what) in TESTS.items():
        print(f"{name:<5} {needs:<30} {what}")


def build_images(args) -> int:
    """Every image the tests upload, and both bootloaders. They come from scratch copies through
    build_image.sh, so none of them can end up in binaries/ or on the console."""
    if args.golden_image:
        data = args.golden_image.read_bytes()
    else:
        _, data = golden.check(golden.Checkout(REPO))
    image = golden.parse_image(data)
    offsets = golden.flip_offsets(data)
    wrong_pin = golden.parse_image(args.wrong_pin_image.read_bytes()).hash_tlv
    if wrong_pin == image.hash_tlv:
        raise TestFailed(f"{args.wrong_pin_image} is the pinned image: name another one")

    def bootloader(digest: str) -> list[str]:
        return ["-Dmcuboot_CONFIG_CRANIUM_GOLDEN=y", f'-Dmcuboot_CONFIG_CRANIUM_GOLDEN_SHA256="{digest}"',
                f"-Dmcuboot_CONFIG_CRANIUM_GOLDEN_SIZE={image.size}"]

    flip = "-Dapp_CONFIG_APP_TEST_FAULT_GOLDEN_FLIP=y"
    builds = [
        ("crash", "1.9.9", "crash.bin", ["-Dapp_CONFIG_APP_TEST_FAULT_CRASH=y",
                                         "-Dapp_CONFIG_APP_WATCHDOG_TIMEOUT_SECONDS=30"]),
        ("wreck", "1.9.7", "wreck.bin", ["-Dapp_CONFIG_APP_TEST_FAULT_WRECK_SLOTS=y"]),
        ("flip", "1.9.6", "flip-body.bin", [flip, f"-Dapp_CONFIG_APP_TEST_GOLDEN_FLIP_OFFSET={offsets['body']}"]),
        ("flip", "1.9.5", "flip-signature.bin", [flip, f"-Dapp_CONFIG_APP_TEST_GOLDEN_FLIP_OFFSET={offsets['signature']}"]),
        ("wrongpin", "1.9.8", "unused-wrongpin.bin", bootloader(wrong_pin)),
    ]
    if args.golden_image:
        builds.append(("pinned", "1.9.4", "unused-pinned.bin", bootloader(image.hash_tlv)))
    for kind, version, name, extra in builds:
        note(f"building {name}")
        subprocess.run([str(REPO / "firmware/tests/hil/build_image.sh"), version, "0",
                        str(args.images / name), *extra], check=True, env={**os.environ, "KIND": kind})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["plan", "images", "run", "press"])
    parser.add_argument("tests", nargs="*", help="for run: the tests, by the names in the plan")
    parser.add_argument("--gesture", choices=["jlink", "person"], default="jlink")
    parser.add_argument("--hold", type=float, default=HOLD_TO_FIRE, help="for press: seconds")
    parser.add_argument("--golden-image", type=Path,
                        help="until something is frozen: the image to test with")
    parser.add_argument("--mcuboot-elf", type=Path, default=REPO / "build/mcuboot/zephyr/zephyr.elf",
                        help="the ELF of the bootloader on the board, for --gesture jlink")
    parser.add_argument("--mcuboot-hex", type=Path, default=REPO / "build/mcuboot/zephyr/zephyr.hex",
                        help="the bootloader under test, which G3 and G9 program")
    parser.add_argument("--app-elf", type=Path, default=REPO / "build/app/zephyr/zephyr.elf",
                        help="the ELF of the image on the board, for G5f")
    parser.add_argument("--wrongpin-hex", type=Path,
                        default=REPO / "build-bench/build-wrongpin/mcuboot/zephyr/zephyr.hex")
    parser.add_argument("--wrongpin-elf", type=Path,
                        default=REPO / "build-bench/build-wrongpin/mcuboot/zephyr/zephyr.elf")
    parser.add_argument("--wrong-pin-image", type=Path, default=REPO / "binaries/cranium-1.3.0-0.signed.bin",
                        help="a validly signed image that is not the pinned one, for images")
    parser.add_argument("--forward-image", type=Path, default=REPO / "binaries/latest.signed.bin",
                        help="for G13: an image newer than the golden one")
    parser.add_argument("--trial-image", type=Path,
                        help="for G15: a newer image built with APP_TEST_FAULT_NO_CONFIRM")
    parser.add_argument("--images", type=Path, default=REPO / "build-bench/images")
    parser.add_argument("--power-cuts", action="store_true",
                        help="G5d and G11 also pull USB, with G11 during a restore and a seal. "
                             "Only with --gesture person")
    parser.add_argument("--out", default=str(REPO / "build-hil-golden"), help="where logs and results go")
    parser.add_argument("--port", help="the board's console (default: its second virtual COM port)")
    parser.add_argument("--serial-number", default="001050797470", help="the probe, for nrfutil")
    parser.add_argument("--jlink", default="/usr/local/bin/JLinkExe")
    parser.add_argument("--jlink-serial", default="1050797470", help="the probe, for J-Link")
    parser.add_argument("--stop-on-failure", action="store_true")
    args = parser.parse_args()

    if args.command == "plan":
        show_plan()
        return 0
    if args.power_cuts and args.gesture != "person":
        parser.error("--power-cuts needs --gesture person: somebody has to pull the cable")
    try:
        if args.command == "images":
            return build_images(args)
        if args.command == "run":
            unknown = [name for name in args.tests if name not in TESTS]
            if unknown or not args.tests:
                parser.error(f"which tests? Not {unknown}. See `golden_bench.py plan`")
        bench = Bench(args)
    except (TestFailed, golden.GoldenError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    try:
        if args.command == "press":
            bench.press(args.hold)
            return 0
        outcomes = {}
        for name in args.tests:
            outcomes[name] = run_test(bench, name)
            if outcomes[name] == "FAIL" and args.stop_on_failure:
                break
        passed = sum(outcome == "PASS" for outcome in outcomes.values())
        partial = [name for name, outcome in outcomes.items() if outcome == "PARTIAL"]
        note(f"{passed} of {len(args.tests)} passed" + (f". Partial, with a part not run: {partial}" if partial else ""))
        return 0 if passed == len(args.tests) else 1
    finally:
        bench.close()


if __name__ == "__main__":
    sys.exit(main())
