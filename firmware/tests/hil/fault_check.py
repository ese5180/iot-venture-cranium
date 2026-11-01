#!/usr/bin/env python3
"""Is the fault that stops the Wi-Fi chip in a built image, or not?

    python3 firmware/tests/hil/fault_check.py --clean build-bench/build-release \
        --fault build-bench/build-WIFI_DEAD

This reads files only. An image that a release could come from must have none of it, in its
configuration or in its bytes. The fault image must have all of it: that is what shows that this
check can find it at all. The strings are what it looks for in the bytes, because the build links
with optimization across files and a symbol's name tells little there.
"""

import argparse
import re
import sys
from pathlib import Path

MARKERS = (b"test image: chip power cut", b"TEST_WIFI_DEAD")
FAULT_OPTION = re.compile(r"^CONFIG_APP_TEST_FAULT_WIFI_DEAD=y$", re.MULTILINE)
RECOVERY_OPTION = re.compile(r"^CONFIG_NRF_WIFI_RPU_RECOVERY=y$", re.MULTILINE)
# Without the recovery the driver's Kconfig would leave this at 5, so an event lost in the fault
# image could look like a fault of the firmware. prj.conf sets it, for every image.
EVENT_QUEUE_OPTION = re.compile(r"^CONFIG_NET_MGMT_EVENT_QUEUE_SIZE=16$", re.MULTILINE)


def read_build(build: Path) -> tuple[str, bytes]:
    return ((build / "app/zephyr/.config").read_text(),
            (build / "app/zephyr/zephyr.signed.bin").read_bytes())


def problems_of_clean(config: str, image: bytes) -> list[str]:
    problems = []
    if FAULT_OPTION.search(config):
        problems.append("its configuration has the fault")
    problems += [f"its image holds {marker.decode()}" for marker in MARKERS if marker in image]
    if not RECOVERY_OPTION.search(config):
        problems.append("the driver's recovery is off, which only the fault image should have")
    if not EVENT_QUEUE_OPTION.search(config):
        problems.append("its network event queue does not have 16 entries")
    return problems


def problems_of_fault(config: str, image: bytes) -> list[str]:
    problems = []
    if not FAULT_OPTION.search(config):
        problems.append("its configuration does not have the fault")
    problems += [f"its image does not hold {marker.decode()}" for marker in MARKERS
                 if marker not in image]
    if RECOVERY_OPTION.search(config):
        problems.append("the driver's recovery is on, which would power the chip up again")
    if not EVENT_QUEUE_OPTION.search(config):
        problems.append("its network event queue does not have 16 entries, as every other image has")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--clean", type=Path, action="append", default=[], required=True,
                        help="a build directory that must have none of it; can be given again")
    parser.add_argument("--fault", type=Path, required=True,
                        help="the build directory of the fault image, which must have all of it")
    args = parser.parse_args()

    failed = False
    for build, check in [(build, problems_of_clean) for build in args.clean] + [(args.fault, problems_of_fault)]:
        problems = check(*read_build(build))
        print(f"{build}: {'; '.join(problems) if problems else 'as it should be'}")
        failed = failed or bool(problems)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
