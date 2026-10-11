"""Talk to a board's serial console.

Shared by the provisioning tools. Needs pyserial, which the nRF Connect SDK toolchain's
Python already has.
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
PROMPT = "uart:~$"


class BoardError(RuntimeError):
    """A console command failed or the board did not answer."""


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


class Console:
    def __init__(self, port: str | None = None):
        self.port = port or find_console_port()
        self.serial = serial.Serial(self.port, 115200, timeout=0.2)

    def close(self) -> None:
        self.serial.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def run(self, command: str, wait: float = 3.0, quiet: bool = False,
            expect_ok: bool = True) -> list[str]:
        """Send one command and return the lines printed in reply.

        Every provisioning command except `prov status` ends with a line that starts
        with "OK", or prints an error instead. With expect_ok the reply is complete
        when that line arrives, however long the command takes (creating a key pair
        prints nothing for a while), and a reply without it raises BoardError. Without
        expect_ok the reply is complete once the board has been quiet for a moment.
        """
        self.serial.write(b"\r")
        time.sleep(0.15)
        self.serial.reset_input_buffer()
        self.serial.write(command.encode("ascii") + b"\r")

        deadline = time.time() + wait
        raw = b""
        last_data = time.time()
        completed = False
        while time.time() < deadline:
            chunk = self.serial.read(4096)
            if chunk:
                raw += chunk
                last_data = time.time()
                seen = ANSI.sub("", raw.decode("utf-8", "replace"))
                if re.search(r"(?m)^(uart:~\$ )?OK\b.*\r?$", seen):
                    # The command reported completion; collect what is left.
                    time.sleep(0.15)
                    raw += self.serial.read(4096)
                    completed = True
                    break
            elif raw and time.time() - last_data > 0.8:
                # Quiet. Done, unless only the echo of the command has arrived so far
                # and an OK line is still to come.
                if not expect_ok or self._reply_lines(raw, command):
                    break

        lines = self._reply_lines(raw, command)

        if not quiet:
            for line in lines:
                if "not found" in line or line.lower().startswith("error"):
                    raise BoardError(f"`{command.split()[0]} ...` failed: {line}")
            if expect_ok and not completed:
                reply = "; ".join(lines) if lines else "no reply"
                raise BoardError(f"`{' '.join(command.split()[:2])}` failed: {reply}")
        return lines

    @staticmethod
    def _reply_lines(raw: bytes, command: str) -> list[str]:
        text = ANSI.sub("", raw.decode("utf-8", "replace"))
        lines = []
        for line in text.splitlines():
            line = line.replace(PROMPT, "").strip()
            if not line or line == command.strip():
                continue
            # Log lines from the firmware are not part of the reply.
            if re.match(r"^\[\d\d:\d\d:\d\d\.\d{3},\d{3}\] <", line):
                continue
            lines.append(line)
        return lines

    def status(self) -> dict[str, str]:
        """Parse `prov status` into a dictionary."""
        result = {}
        for line in self.run("prov status", expect_ok=False):
            match = re.match(r"^([A-Za-z][A-Za-z ]+?)\s{2,}(.*)$", line)
            if match:
                result[match.group(1).strip()] = match.group(2).strip()
        if "thing name" not in result:
            raise BoardError("the board did not answer `prov status`: is it running the "
                             "development build of this firmware?")
        return result
