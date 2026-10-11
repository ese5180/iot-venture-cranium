"""Where this machine keeps the project's secrets.

They live in ~/.cranium, outside the repository: a file that is not in the working tree
cannot be committed by accident, and it stays out of folders that are synchronised to a
cloud drive (Desktop and Documents often are). The firmware build reads the signing key
from the same place.
"""

import os
from pathlib import Path

LOCAL_DIR = Path.home() / ".cranium"
SIGNING_KEY = LOCAL_DIR / "mcuboot_signing_key.pem"
WIFI_SECRETS = LOCAL_DIR / "wifi_secrets.h"


def ensure_local_dir() -> Path:
    LOCAL_DIR.mkdir(mode=0o700, exist_ok=True)
    if os.name == "posix":
        os.chmod(LOCAL_DIR, 0o700)
    return LOCAL_DIR
