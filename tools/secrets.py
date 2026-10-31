#!/usr/bin/env python3
"""Create and lock the local Wi-Fi secrets file.

    python tools/secrets.py wifi      ask for the network and write ~/.cranium/wifi_secrets.h
    python tools/secrets.py status    show which local secrets exist and who can read them

The file is kept outside the repository (see tools/local.py), so it cannot be committed
and does not end up in a synchronised folder.

`wifi` writes the file owned by root with mode 0600, so reading it afterwards needs an
administrator password (the provisioning tool asks for it through sudo). With --unlocked
the file stays owned by you, for a test bench that has to provision without anyone at the
keyboard. The passphrase is typed without echo and never appears on a command line.
"""

import argparse
import getpass
import os
import stat
import subprocess
import sys
from pathlib import Path

from local import LOCAL_DIR as SECRETS, WIFI_SECRETS as WIFI, ensure_local_dir

SECURITIES = ("WPA2_PSK", "WPA2_PSK_SHA256", "WPA3_SAE")

TEMPLATE = """/*
 * Wi-Fi credentials used to provision a development board.
 * Written by tools/secrets.py. Not compiled into firmware and never committed.
 */
#ifndef WIFI_SECRETS_H_
#define WIFI_SECRETS_H_

#define WIFI_SECRETS_SSID "{ssid}"
#define WIFI_SECRETS_PASSPHRASE "{passphrase}"
#define WIFI_SECRETS_SECURITY {security}

#endif /* WIFI_SECRETS_H_ */
"""


def c_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def known_spelling(ssid: str) -> str | None:
    """A network this Mac has joined whose name differs from the typed one only in case
    or apostrophe. A board needs the exact name: a phone's hotspot has a curly apostrophe
    that nobody types by hand, and with a straight one the board just never finds it.
    """
    def plain(name: str) -> str:
        return name.replace("’", "'").casefold()

    try:
        listing = subprocess.run(["networksetup", "-listpreferredwirelessnetworks", "en0"],
                                 capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    names = [line.strip() for line in listing.splitlines()[1:]]
    if ssid in names:
        return None
    return next((name for name in names if plain(name) == plain(ssid)), None)


def wifi(unlocked: bool = False) -> None:
    if os.name != "posix":
        sys.exit("Locking the file is only implemented for macOS and Linux")

    ssid = input("Wi-Fi network name (SSID): ").strip()
    if not 1 <= len(ssid.encode()) <= 32:
        sys.exit("An SSID is 1 to 32 bytes long")

    known = known_spelling(ssid)
    if known and input(f"This Mac knows that network as \"{known}\". Use that? [Y/n] ").strip().lower() != "n":
        ssid = known

    passphrase = getpass.getpass("Passphrase (not shown): ")
    if passphrase != getpass.getpass("Passphrase again: "):
        sys.exit("The two entries differ")
    if not 8 <= len(passphrase) <= 63 or not passphrase.isascii():
        sys.exit("A WPA2/WPA3 passphrase is 8 to 63 ASCII characters")

    security = input(f"Security {SECURITIES} [WPA2_PSK]: ").strip() or "WPA2_PSK"
    if security not in SECURITIES:
        sys.exit("Open, WEP and WPA (TKIP) networks are not supported")

    content = TEMPLATE.format(ssid=c_string(ssid), passphrase=c_string(passphrase),
                              security=security)
    ensure_local_dir()

    if unlocked:
        # Owner-only, without root: the provisioning tool can then run unattended. A file that
        # was locked before belongs to root, and this folder is the only thing that is ours.
        WIFI.unlink(missing_ok=True)
        descriptor = os.open(WIFI, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as file:
            file.write(content)
        print(f"Wrote {WIFI} (owner you, mode 600, outside the repository)")
        return

    print("Writing the file as root so that reading it needs an administrator password.")
    # The root shell receives the content on stdin, so the passphrase is never
    # an argument that other processes could see.
    subprocess.run(["sudo", "sh", "-c",
                    'umask 077 && cat > "$1" && chown root "$1" && chmod 600 "$1"',
                    "sh", str(WIFI)], input=content.encode(), check=True,
                   stdout=subprocess.DEVNULL)
    print(f"Wrote {WIFI} (owner root, mode 600, outside the repository)")


def status() -> None:
    if not SECRETS.is_dir() or not any(SECRETS.iterdir()):
        print(f"{SECRETS} holds nothing yet")
        return
    for path in sorted(SECRETS.iterdir()):
        info = path.stat()
        owner = "root" if info.st_uid == 0 else "you" if info.st_uid == os.getuid() else str(info.st_uid)
        mode = stat.filemode(info.st_mode)
        note = "" if not (info.st_mode & 0o077) else "  <- readable by others: chmod 600"
        print(f"{mode}  owner {owner:<4}  {path}{note}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["wifi", "status"])
    parser.add_argument("--unlocked", action="store_true",
                        help="wifi: keep the file owned by you, so that no administrator "
                             "password is needed to provision a board")
    args = parser.parse_args()
    if args.command == "wifi":
        wifi(args.unlocked)
    else:
        status()


if __name__ == "__main__":
    main()
