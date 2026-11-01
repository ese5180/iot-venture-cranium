#!/usr/bin/env python3
"""Install a firmware image through the bootloader's serial recovery.

    python tools/recover.py list                 show the image the bootloader holds
    python tools/recover.py upload <signed.bin>  write it into the primary slot and restart
    python tools/recover.py reset                restart the board

This is the way back when an image cannot reach the network, and it needs neither Wi-Fi
nor a debugger. Get the board into the bootloader in one of four ways:

  * pass --console: this sends ENTER_BOOTLOADER to the running application, which restarts,
    and catches the half second after a reset in which the bootloader listens for a command;
  * hold Button 1 while you press RESET, then run this tool;
  * pass --reset: this restarts the board through its debug port and catches the same half
    second;
  * do nothing if no valid image is left: the bootloader then stays by itself.

The bootloader takes whatever it is sent, but it starts nothing that does not carry this
project's signature: a badly signed image is refused at the restart, and the bootloader
stays and waits for a good one. Use build/app/zephyr/zephyr.signed.bin.

It talks to the board's second virtual COM port, the one the application's console uses,
so close any terminal on that port first. Uses the SMP protocol that AuTerm and mcumgr
speak. Run from an nRF Connect SDK terminal, which provides pyserial and cbor2.
"""

import argparse
import base64
import struct
import subprocess
import sys
import time
from pathlib import Path

from board import BoardError, find_console_port

try:
    import cbor2
    import serial
except ImportError:  # pragma: no cover
    sys.exit("pyserial or cbor2 is missing: run this from an nRF Connect SDK terminal")

OP_READ, OP_WRITE = 0, 2
GROUP_OS, GROUP_IMAGE = 0, 1
ID_OS_ECHO, ID_OS_RESET = 0, 5
ID_IMAGE_STATE, ID_IMAGE_UPLOAD = 0, 1

# A line holds 124 base64 characters, which is 93 bytes, between its two start bytes and
# the newline. The bootloader buffers eight lines while it writes to flash.
LINE_BYTES = 93
CHUNK = 384
REPLY_TIMEOUT = 8
GREETING_EVERY = 0.1
MAX_LOST = 3
# Goes to the running application's console. It starts with a line ending, which finishes
# anything half-typed there, and the bootloader ignores it if it is the one that is listening.
ENTER_BOOTLOADER = b"\rENTER_BOOTLOADER\r"
# How long a board gets to reach the bootloader's window, in seconds. The window comes after the
# bootloader has dealt with the slots, so a swap being resumed makes it late: 81 s were measured. Button 2
# held down at a reset makes it later still: the golden image's check gives up on the button after 60 s.
ENTER_AFTER_RESTART = 15
ENTER_ALREADY_LISTENING = 3
ENTER_THROUGH_A_SWAP = 150
# The bootloader looks at what it has received only once it has checked the image, which takes longer
# than its half second, and then that look lasts a millisecond (CONFIG_BOOT_SERIAL_WAIT_FOR_DFU in
# MCUboot's main.c). Now and then a restart goes past it: 1 in 75 on the bench. So --reset tries again.
ENTER_RESTARTS = 3
# What arrives this soon after a restart was on its way before it: the bootloader needs longer than
# this to check the image, and the application longer still to start.
RESTART_SETTLE = 0.3


class NoAnswer(BoardError):
    """No reply to a request in time."""


def crc16(data: bytes) -> int:
    """CRC-16/XMODEM: polynomial 0x1021, starts at zero."""
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021 if crc & 0x8000 else crc << 1) & 0xffff
    return crc


class Link:
    # Plain text has arrived: on this port only a running application sends any.
    heard_text = False

    def __init__(self, port: str):
        self.serial = serial.Serial(port, 115200, timeout=0.05)
        self.sequence = 0
        self.received = b""

    def close(self) -> None:
        self.serial.close()

    def send(self, op: int, group: int, command: int, body: dict) -> None:
        self.sequence = (self.sequence + 1) & 0xff
        payload = cbor2.dumps(body)
        packet = struct.pack(">BBHHBB", op, 0, len(payload), group, self.sequence, command) + payload
        packet += struct.pack(">H", crc16(packet))
        framed = struct.pack(">H", len(packet)) + packet
        for offset in range(0, len(framed), LINE_BYTES):
            start = b"\x06\x09" if offset == 0 else b"\x04\x14"
            self.serial.write(start + base64.b64encode(framed[offset:offset + LINE_BYTES]) + b"\n")

    def drain(self) -> None:
        """Forget what has arrived so far, once the board has had a moment to finish."""
        time.sleep(0.2)
        self.serial.reset_input_buffer()
        self.received = b""

    def receive(self, timeout: float) -> dict | None:
        """The reply to the last request as a dictionary, or None when none arrived in
        time. A reply carries the number of its request: one to an earlier request, which
        arrives late, is not the answer that is being waited for.
        """
        deadline = time.time() + timeout
        framed = b""
        while time.time() < deadline:
            self.received += self.serial.read(512)
            while b"\n" in self.received:
                line, self.received = self.received.split(b"\n", 1)
                line = line.strip(b"\r")
                if line[:2] == b"\x06\x09":
                    framed = b""
                elif line[:2] != b"\x04\x14":
                    self.heard_text = self.heard_text or bool(line)
                    continue
                try:
                    framed += base64.b64decode(line[2:])
                except ValueError:
                    framed = b""
                    continue
                if len(framed) >= 2 and len(framed) - 2 >= struct.unpack(">H", framed[:2])[0]:
                    packet = framed[2:]
                    framed = b""
                    if crc16(packet) != 0 or len(packet) < 10 or packet[6] != self.sequence:
                        continue
                    return cbor2.loads(packet[8:-2])
        return None

    def request(self, op: int, group: int, command: int, body: dict) -> dict:
        self.send(op, group, command, body)
        reply = self.receive(REPLY_TIMEOUT)
        if reply is None:
            raise NoAnswer("the bootloader did not answer")
        if reply.get("rc", 0) != 0:
            raise BoardError(f"the bootloader answered with error {reply['rc']}")
        return reply


def enter(link: Link, serial_number: str | None, through_console: bool = False,
          deadline_seconds: float | None = None) -> None:
    """Make sure the bootloader is listening, restarting the board first if asked to.

    Give deadline_seconds if the board may be in the middle of a swap (ENTER_THROUGH_A_SWAP).

    If the application answers after a restart through the debug port, the bootloader has passed the
    board on without seeing a greeting, and it is restarted again. A swap says nothing on this port,
    so a board that is busy with one is left alone.

    Nothing that arrives before a restart has landed counts, or just after: an answer from a bootloader
    that is about to be restarted says nothing about the next one.
    """
    def restart() -> subprocess.Popen:
        return subprocess.Popen(["nrfutil", "device", "reset", "--reset-kind", "RESET_PIN",
                                 "--serial-number", serial_number],
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

    reset = restart() if serial_number is not None else None
    restarted_at = None
    restarts_left = ENTER_RESTARTS
    if through_console:
        # Greetings that reach the application before it restarts are nothing to it but
        # lines it refuses, and it answers them in plain text, which is ignored here.
        link.serial.write(ENTER_BOOTLOADER)
    if deadline_seconds is None:
        deadline_seconds = ENTER_AFTER_RESTART if reset or through_console else ENTER_ALREADY_LISTENING
    deadline = time.time() + deadline_seconds
    while time.time() < deadline:
        # Slowly enough that the bootloader's eight line buffers do not fill up before it
        # starts reading them, and often enough for a window of half a second.
        link.send(OP_WRITE, GROUP_OS, ID_OS_ECHO, {"d": "cranium"})
        reply = link.receive(GREETING_EVERY)
        if reset is not None:
            status = reset.poll()
            if status:
                raise BoardError(f"nrfutil could not restart the board through probe {serial_number}: "
                                 f"{reset.stderr.read().strip()}\nName another probe with --serial-number")
            if status is None:
                restarted_at = None
                continue
            if restarted_at is None:
                restarted_at = time.time()
            if time.time() - restarted_at < RESTART_SETTLE:
                link.heard_text = False
                continue
        if reply is not None:
            # The bootloader may still answer the greetings sent just before this one.
            link.drain()
            return
        if reset is not None and link.heard_text and restarts_left > 0:
            restarts_left -= 1
            print("  the board went past the bootloader, restarting it again", flush=True)
            reset = restart()
            restarted_at = None
    raise BoardError("the bootloader is not listening: hold Button 1, press RESET, release "
                     "Button 1 and try again, or pass --console or --reset. A board resuming a swap, or "
                     f"with Button 2 stuck down, takes longer to get there: give it --wait {ENTER_THROUGH_A_SWAP}")


def upload(link: Link, image: bytes) -> None:
    started = time.time()
    offset = 0
    next_report = 0
    lost = 0
    while offset < len(image):
        body = {"off": offset, "data": image[offset:offset + CHUNK], "image": 0}
        if offset == 0:
            body["len"] = len(image)
        try:
            reply = link.request(OP_WRITE, GROUP_IMAGE, ID_IMAGE_UPLOAD, body)
        except NoAnswer:
            # Send it again: the bootloader answers with where it really is.
            lost += 1
            if lost > MAX_LOST:
                raise
            print(f"  no answer at {offset}, trying again", flush=True)
            link.drain()
            continue
        lost = 0
        if "off" not in reply:
            raise BoardError(f"the bootloader answered without an offset: {reply}")
        offset = reply["off"]
        percent = offset * 100 // len(image)
        if percent >= next_report:
            print(f"  {percent:3d} %  {offset} of {len(image)} bytes", flush=True)
            next_report = percent + 10
    print(f"Sent {len(image)} bytes in {time.time() - started:.0f} s")


def show(link: Link) -> list[dict]:
    """The images the bootloader lists, each with its slot, version and hash where it says so.

    It lists only images that pass validation, so an image with a bad signature is not here.
    """
    reply = link.request(OP_READ, GROUP_IMAGE, ID_IMAGE_STATE, {})
    return [{"slot": image.get("slot", 0), "version": image.get("version", "?"),
             "hash": image["hash"].hex() if isinstance(image.get("hash"), bytes) else None}
            for image in reply.get("images", [])]


def print_images(images: list[dict]) -> None:
    for image in images:
        print(f"slot {image['slot']}: version {image['version']}"
              + (f", hash {image['hash']}" if image["hash"] else ""))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["list", "upload", "reset"])
    parser.add_argument("image", nargs="?", type=Path, help="signed image, for upload")
    parser.add_argument("--port", help="serial port (default: the board's second virtual COM port)")
    parser.add_argument("--reset", action="store_true",
                        help="restart the board through its debug port to enter the bootloader")
    parser.add_argument("--serial-number", default="001050797470",
                        help="the debug probe to use with --reset")
    parser.add_argument("--console", action="store_true",
                        help="send ENTER_BOOTLOADER to the running application to enter the "
                             "bootloader, without a debugger")
    parser.add_argument("--wait", type=float, metavar="SECONDS",
                        help="how long the board gets to reach the bootloader; give about "
                             f"{ENTER_THROUGH_A_SWAP} if it may be resuming a swap")
    args = parser.parse_args()

    if args.command == "upload" and args.image is None:
        parser.error("upload needs the signed image")
    if args.reset and args.console:
        parser.error("--reset and --console are two ways of doing the same thing: pick one")

    link = Link(args.port or find_console_port())
    try:
        enter(link, args.serial_number if args.reset else None, args.console, args.wait)
        if args.command == "list":
            print_images(show(link))
        elif args.command == "upload":
            upload(link, args.image.read_bytes())
            link.request(OP_WRITE, GROUP_OS, ID_OS_RESET, {})
            print("Restarting. The bootloader checks the signature before it starts the image.")
        else:
            link.request(OP_WRITE, GROUP_OS, ID_OS_RESET, {})
            print("Restarting.")
    except BoardError as error:
        sys.exit(f"error: {error}")
    finally:
        link.close()


if __name__ == "__main__":
    main()
