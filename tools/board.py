"""Talk to a board's serial console.

Used by tools/provision_device.py and the hardware test benches. Needs pyserial, which the
nRF Connect SDK toolchain's Python already has.

A command is one line, COMMAND|arg1|arg2. Its reply ends with one final line, OK or ERR,
and any other lines of the reply come before that. Lines that start with a [TAG] are logs
and events from the running firmware, which can appear at any time and belong to no reply.
"""

import re
import sys
import time

try:
    import serial
    from serial.tools import list_ports
except ImportError:  # pragma: no cover
    sys.exit("pyserial is missing: run this from an nRF Connect SDK terminal")

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
FINAL_LINE = re.compile(r"^(OK|ERR)( |$)")
TAGGED_LINE = re.compile(r"^\[[^\]]*\]")
KEY_VALUE = re.compile(r"^([A-Za-z][A-Za-z ]+?)\s{2,}(.*)$")
# Logs of firmware with the old shell: [00:00:12.345,678] <inf> ota: text
SHELL_LOG_LINE = re.compile(r"^\[\d\d:\d\d:\d\d\.\d{3},\d{3}\] <")
ECHO_OFF = "ECHO|OFF"
ECHO_OFF_REPLY = "OK echo off"
HANDSHAKE_SECONDS = 2.0
STATUS_SECONDS = 8.0
SHELL_QUIET_SECONDS = 0.8


class BoardError(RuntimeError):
    """A console command failed or the board did not answer."""


class ShellFirmware(BoardError):
    """The board runs firmware from before the console: it has a Zephyr shell there."""


def find_console_port() -> str:
    """Return the nRF7002 DK's application console (its second virtual COM port)."""
    ports = sorted(p.device for p in list_ports.comports()
                   if p.vid == 0x1366 and "usbmodem" in p.device.lower())
    if not ports:
        ports = sorted(p.device for p in list_ports.comports() if p.vid == 0x1366)
    if not ports:
        raise BoardError("no J-Link virtual COM port found: is the board connected?")
    # VCOM1 carries the application console; VCOM0 carries TF-M's log.
    return ports[-1]


def crc16_ccitt_false(data: bytes) -> int:
    """CRC-16/CCITT-FALSE, which STREAM_START announces: polynomial 0x1021, starts at 0xFFFF."""
    crc = 0xffff
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021 if crc & 0x8000 else crc << 1) & 0xffff
    return crc


def command_name(command: str) -> str:
    """The part of a command that may be shown: what follows can be a password."""
    return command.split("|", 1)[0]


def parse_key_values(lines: list[str]) -> dict[str, str]:
    """Lines of the form "thing name     cranium-1234", as STATUS and NET print them."""
    result = {}
    for line in lines:
        match = KEY_VALUE.match(line)
        if match:
            result[match.group(1).strip()] = match.group(2).strip()
    return result


def parse_get_id(final: str) -> tuple[str, str]:
    """The ID and the firmware version from GET_ID's "OK <id>|<version>"."""
    match = re.fullmatch(r"OK ([^|]*)\|(\S+)", final)
    if not match:
        raise BoardError(f"unexpected reply to GET_ID: {final}")
    return match.group(1), match.group(2)


class Console:
    def __init__(self, port: str | None = None, link=None):
        self.port = port or find_console_port()
        self.serial = link if link is not None else serial.Serial(self.port, 115200, timeout=0.2)
        self.pending = b""

    def close(self) -> None:
        self.serial.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def lines(self, deadline: float):
        """Complete lines as they arrive, until the deadline."""
        while True:
            while b"\n" in self.pending:
                line, self.pending = self.pending.split(b"\n", 1)
                yield line.decode("utf-8", "replace").strip()
            if time.time() >= deadline:
                return
            self.pending += self.serial.read(4096)

    def handshake(self) -> None:
        """Turn the echo off, which also shows that everything earlier has been answered.

        Echo comes back on at every restart, and the echo of a Wi-Fi command would put the
        password into any log of this port, so this comes before every single command.
        """
        self.pending = b""
        # A second try: the board discards a line it lost bytes of, and that can be the first.
        for _ in range(2):
            self.serial.write(b"\r" + ECHO_OFF.encode() + b"\r")
            for line in self.lines(time.time() + HANDSHAKE_SECONDS):
                if line == ECHO_OFF_REPLY:
                    return
                if "command not found" in line:
                    raise ShellFirmware(f"the board on {self.port} runs firmware from before "
                                        "the console; install this firmware first")
        raise BoardError(f"the board on {self.port} does not answer: is it restarting?")

    def exchange(self, command: str, wait: float = 3.0) -> tuple[list[str], str]:
        """Send one command. Returns the lines of its reply and its final line."""
        self.handshake()
        self.serial.write(command.encode("utf-8") + b"\r")
        reply = []
        for line in self.lines(time.time() + wait):
            if not line or TAGGED_LINE.match(line) or line == command:
                continue
            # A handshake that was given up on while the board was busy, answered late.
            if line == ECHO_OFF_REPLY and command != ECHO_OFF:
                continue
            if FINAL_LINE.match(line):
                return reply, line
            reply.append(line)
        raise BoardError(f"`{command_name(command)}` got no final line within {wait:.0f} s")

    def run(self, command: str, wait: float = 3.0) -> list[str]:
        """Send one command and return the lines of its reply. ERR raises BoardError.

        An error shows the command's name and the board's reason, which never holds a
        secret. It never shows the arguments, or the other lines of the reply.
        """
        reply, final = self.exchange(command, wait)
        if not final.startswith("OK"):
            raise BoardError(f"`{command_name(command)}` failed: {final[4:]}")
        return reply

    def status(self) -> dict[str, str]:
        """What the board says about itself, in any mode.

        The keys are those of the STATUS command. In factory mode STATUS is refused, so
        only the state, the ID, the firmware and the thing name are there. Firmware from
        before the console has no state at all.
        """
        try:
            reply, final = self.exchange("STATUS", STATUS_SECONDS)
        except ShellFirmware:
            return self._shell_status()
        if final.startswith("ERR factory mode"):
            return self._factory_status()
        result = parse_key_values(reply)
        if "thing name" not in result:
            raise BoardError(f"the board did not answer STATUS properly: {final}")
        return result

    def _factory_status(self) -> dict[str, str]:
        device_id, firmware = self.get_id()
        _, thing = self.exchange("THING")
        return {"state": "FACTORY", "id": device_id, "firmware": firmware,
                "thing name": thing.removeprefix("OK ")}

    def get_id(self) -> tuple[str, str]:
        """The ID, which is empty on a board in factory mode, and the firmware version."""
        return parse_get_id(self.exchange("GET_ID")[1])

    def press(self, button: int) -> None:
        """Act as if a button was pressed. It takes the path of the real button."""
        try:
            self.run(f"BUTTON|{button}")
        except ShellFirmware:
            self._shell_command(f"prov button {button}")

    def wait_until_up(self, timeout: float = 30.0) -> None:
        """Wait for the board to answer again after it has restarted."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                self.exchange("GET_ID")
                return
            except BoardError:
                time.sleep(0.5)
        raise BoardError(f"the board did not come back within {timeout:.0f} s")

    # Firmware before 1.3.0 has a Zephyr shell on this port. An update from it to this
    # firmware still has to be driven through it: its status and its button.

    def _shell_command(self, command: str, wait: float = 3.0) -> list[str]:
        self.serial.write(command.encode("ascii") + b"\r")
        deadline = time.time() + wait
        raw = b""
        last_data = time.time()
        while time.time() < deadline:
            chunk = self.serial.read(4096)
            if chunk:
                raw += chunk
                last_data = time.time()
            elif raw and time.time() - last_data > SHELL_QUIET_SECONDS:
                break
        lines = []
        for line in ANSI.sub("", raw.decode("utf-8", "replace")).splitlines():
            line = line.replace("uart:~$", "").strip()
            if line and line != command and not SHELL_LOG_LINE.match(line):
                lines.append(line)
        return lines

    def _shell_status(self) -> dict[str, str]:
        result = parse_key_values(self._shell_command("prov status"))
        if "thing name" not in result:
            raise BoardError("the board did not answer `prov status`")
        return result
