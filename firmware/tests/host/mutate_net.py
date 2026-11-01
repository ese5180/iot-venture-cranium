#!/usr/bin/env python3
"""Do the tests of net.c notice when what it tells the join policy is wrong?

    python3 firmware/tests/host/mutate_net.py

mutate_join.py is for the policy itself. This is for the lines of src/net.c that feed it, one change at
a time, each built with test_app.c, which runs the real net.c on a fake network stack. It stops with
an error if a change survives.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

HOST = Path(__file__).resolve().parent
SOURCE = HOST.parents[1] / "app/src"
CJSON = Path(os.environ.get("ZEPHYR_BASE", "/opt/nordic/ncs/v3.4.0/zephyr")) / "../modules/lib/cjson"
DEFINES = ["-D_GNU_SOURCE", "-DCONFIG_APP_CONSOLE=1", "-DCONFIG_APP_LOG_LEVEL=0",
           '-DCONFIG_APP_THING_NAME_PREFIX="cranium-"', "-DCONFIG_MQTT_HELPER_SEC_TAG=201",
           "-DCONFIG_APP_DOWNLOAD_SEC_TAG=202"]
RUN_SECONDS = 60

# What it is, the text as it is in net.c, and what it becomes.
MUTANTS = [
    ("a result is no change of the link",
     "\t\t/* Good or bad, the chip has just been at work on it, and that join is over. */\n\t\tnote_link_change();\n",
     "\t\t/* Good or bad, the chip has just been at work on it, and that join is over. */\n"),
    ("a result does not end the join",
     "\t\tnote_link_change();\n\t\tatomic_set(&join_asked_at, 0);\n\t}\n\n\tif (event == NET_EVENT_WIFI_CONNECT_RESULT && status != NULL && status->status != 0) {",
     "\t\tnote_link_change();\n\t}\n\n\tif (event == NET_EVENT_WIFI_CONNECT_RESULT && status != NULL && status->status != 0) {"),
    ("a disconnect does not end the join",
     "\t\tnote_left();\n\t\tatomic_set(&join_asked_at, 0);\n", "\t\tnote_left();\n"),
    ("no join is ever under way",
     "\t\tatomic_set(&join_asked_at, (atomic_val_t)(uint32_t)(k_uptime_get() + 1));\n", ""),
    ("a refused request counts as under way",
     "\tif (err) {\n\t\tatomic_set(&join_asked_at, 0);\n", "\tif (err) {\n"),
    ("giving up on leaving leaves the join under way",
     "\tatomic_set(&associated, 0);\n\tatomic_set(&join_asked_at, 0);\n", "\tatomic_set(&associated, 0);\n"),
    ("the policy is not told of a join", ".joining = asked_at != 0,", ".joining = false,"),
    ("the policy is told of a join always", ".joining = asked_at != 0,", ".joining = true,"),
    ("the time of the join is off by one", ".joining_since_ms = asked_at - 1,", ".joining_since_ms = asked_at,"),
    ("news of an association leaves a held retry",
     "\t\tseconds_down = 0;\n\t\tjoin_link_came_up(&join);\n", "\t\tseconds_down = 0;\n"),
    ("a link that is up leaves a held retry",
     "\tif (atomic_get(&link_up)) {\n\t\tjoin_link_came_up(&join);\n\t}\n\n", ""),
    ("a retry is a request like any other", "\t\tjoin_retry(&join);\n", "\t\tjoin_request(&join);\n"),
    ("a retry does not start a new attempt's report",
     "\t\tatomic_set(&last_failure, 0);\n\t\tjoin_retry(&join);\n", "\t\tjoin_retry(&join);\n"),
]


def build_and_run(folder: Path, compiler: str) -> str:
    binary = folder / "test"
    built = subprocess.run([compiler, "-std=c11", "-O0", "-w", f"-I{folder}", f"-I{SOURCE}",
                            f"-I{HOST}/stubs", f"-I{CJSON}", *DEFINES, "-o", str(binary),
                            str(HOST / "test_app.c"), str(SOURCE / "stuck_policy.c"),
                            str(SOURCE / "join_policy.c")], capture_output=True, text=True)
    if built.returncode != 0:
        return "does not compile: " + built.stderr[:300]
    try:
        ran = subprocess.run([str(binary)], stdout=subprocess.DEVNULL, timeout=RUN_SECONDS)
    except subprocess.TimeoutExpired:
        return "killed"
    return "killed" if ran.returncode != 0 else "survived"


def main() -> int:
    compiler = os.environ.get("CC", "cc")
    source = (SOURCE / "net.c").read_text()
    survivors = 0
    with tempfile.TemporaryDirectory() as name:
        folder = Path(name)
        (folder / "net.c").write_text(source)
        if build_and_run(folder, compiler) != "survived":
            print("the tests do not pass on net.c as it is")
            return 2
        for what, old, new in MUTANTS:
            if source.count(old) != 1:
                print(f"this no longer fits net.c: {what}")
                return 2
            (folder / "net.c").write_text(source.replace(old, new))
            result = build_and_run(folder, compiler)
            print(f"{result:10} {what}")
            survivors += result != "killed"
    print(f"{len(MUTANTS)} changes: {len(MUTANTS) - survivors} killed, {survivors} survived")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
