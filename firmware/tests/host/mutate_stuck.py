#!/usr/bin/env python3
"""Do the tests of the stuck policy notice when it is wrong?

    python3 firmware/tests/host/mutate_stuck.py

This makes small changes to a copy of src/stuck_policy.c and src/stuck_policy.h, one at a time:
comparisons turned round, limits off by one, a term of the gate left out, a statement left out.
Each one is built with test_stuck_policy.c. A change that the tests pass is a hole in them, or a
change that means nothing, and it is listed here. Nothing in the source tree is touched, and it
needs nothing but a C compiler (CC, by default cc).

It stops with an error if a change survives that is not on the list below of those that mean
nothing, each with the reason.
"""

import dataclasses
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HOST = Path(__file__).resolve().parent
SOURCE = HOST.parents[1] / "app/src"
TEST = HOST / "test_stuck_policy.c"
FILES = ("stuck_policy.c", "stuck_policy.h")
# A change can make a test wait for ever. The tests take well under a second when they pass.
RUN_SECONDS = 10

# Changes that make no difference to what the policy decides, by file and the line as changed.
MEANS_NOTHING = {
    # The gate treats every timer but the stall the same way.
    ("stuck_policy.c", "if (!stuck_gate_open(board, STUCK_REASON_NONE) || board->link_up || answered) {"),
    ("stuck_policy.c", "if (!stuck_gate_open(board, STUCK_REASON_NO_CLOUD) || board->link_up || answered) {"),
    ("stuck_policy.c", "if (!stuck_gate_open(board, STUCK_REASON_NONE) || board->cloud_up ||"),
    ("stuck_policy.c", "if (!stuck_gate_open(board, STUCK_REASON_WIFI_SILENT) || board->cloud_up ||"),
    # The record stays 8 bytes with one reserved byte less: the compiler pads it.
    ("stuck_policy.h", "uint8_t reserved[1];"),
    # Any bit of its own will do for this flag.
    ("stuck_policy.h", "#define STUCK_DO_RESTART (1U << 3)"),
}


@dataclasses.dataclass
class Mutant:
    file: str
    line: int
    what: str
    text: str


def code_only(text: str) -> str:
    """The source with comments, strings and preprocessor lines but #define blanked out."""
    blanked = list(text)

    def blank(start: int, end: int) -> None:
        for i in range(start, end):
            if blanked[i] != "\n":
                blanked[i] = " "

    for match in re.finditer(r"/\*.*?\*/|\"(?:\\.|[^\"\\])*\"", text, re.DOTALL):
        blank(match.start(), match.end())
    for match in re.finditer(r"^#(?!define).*$", text, re.MULTILINE):
        blank(match.start(), match.end())
    return "".join(blanked)


# What gets replaced, and with what, anywhere in the code.
REPLACEMENTS = [
    (r">=", ["<", ">"]),
    (r"(?<![-<>=!])<(?![=<])", [">=", "<="]),
    (r"<=", [">", "<"]),
    (r"(?<!-)>(?![=>])", ["<=", ">="]),
    (r"==", ["!="]),
    (r"!=", ["=="]),
    (r"&&", ["||"]),
    (r"\|\|", ["&&"]),
    (r"!(?=[\w(])", [""]),
    (r"\+=", ["-=", "="]),
    (r"(?<=\w)\+\+", ["--", ""]),
    (r"\btrue\b", ["false"]),
    (r"\bfalse\b", ["true"]),
    (r" - ", [" + "]),
    (r" \* (?=\d)", [" + "]),
    (r"(?<![\w.])\d+(?![\w.])", None),
    (r"STUCK_DO_(RESTART|WRITE|ERASE)", ["0"]),
    (r"STUCK_REASON_(NONE|WIFI_SILENT|NO_CLOUD|UPDATE_STALL)(?=[;\s,)])",
     ["STUCK_REASON_NONE", "STUCK_REASON_WIFI_SILENT", "STUCK_REASON_NO_CLOUD",
      "STUCK_REASON_UPDATE_STALL"]),
    (r"STUCK_UPDATE_(NONE|WATCHED|BOUNDED)(?=[;\s,)])",
     ["STUCK_UPDATE_NONE", "STUCK_UPDATE_WATCHED", "STUCK_UPDATE_BOUNDED"]),
]

# A condition with one of its terms taken out: the term's value, as if it were never there.
TERMS = [
    (r"board->factory", "false"),
    (r"!board->network_stored", "false"),
    (r"!board->provisioned", "false"),
    (r"board->trial", "false"),
    (r"board->bt_window", "false"),
    (r"timer == STUCK_REASON_UPDATE_STALL", "false"),
    (r"board->update == STUCK_UPDATE_NONE", "true"),
    (r"!stuck_gate_open\(board, STUCK_REASON_\w+\)", "false"),
    (r"board->link_up", "false"),
    (r"board->link_up", "true"),
    (r"board->cloud_up", "false"),
    (r"board->cloud_up", "true"),
    (r"\banswered\b", "false"),
    (r"\bprogress\b", "false"),
    (r"board->update != STUCK_UPDATE_WATCHED", "false"),
    (r"state->proof", "true"),
    (r"board->uptime_seconds >= STUCK_HEALTHY_SECONDS", "true"),
    (r"state->silent_seconds < STUCK_WIFI_SILENT_SECONDS", "true"),
    (r"state->no_cloud_seconds < STUCK_NO_CLOUD_SECONDS", "true"),
    (r"state->link_down_seconds >= STUCK_LINK_GONE_SECONDS", "false"),
    (r"reason != STUCK_REASON_UPDATE_STALL", "true"),
    (r"reason == STUCK_REASON_UPDATE_STALL", "false"),
    (r"state->count > 0", "false"),
    (r"state->reason != STUCK_REASON_NONE", "false"),
    (r"board->uptime_seconds >= stuck_min_uptime_seconds\(state->count\)", "true"),
    (r"record != NULL", "true"),
    (r"record->magic == STUCK_RECORD_MAGIC", "true"),
    (r"record->count <= STUCK_COUNT_MAX", "true"),
    (r"record->reason <= STUCK_REASON_UPDATE_STALL", "true"),
    (r"state->count < STUCK_COUNT_MAX", "true"),
]

# A statement on a line of its own, which is left out. Not a declaration or a jump.
STATEMENT = re.compile(r"^\s+((?:state|record)[\w.>-]*(?:\s*(?:=|\+=).*|\+\+);)\s*$", re.MULTILINE)


def mutants_of(file: str, text: str):
    code = code_only(text)
    line_of = lambda position: text.count("\n", 0, position) + 1  # noqa: E731

    def change(start: int, end: int, new: str, what: str) -> Mutant:
        return Mutant(file, line_of(start), what, text[:start] + new + text[end:])

    for pattern, news in REPLACEMENTS:
        for match in re.finditer(pattern, code):
            old = match.group(0)
            if news is None:
                value = int(old)
                options = [str(value + 1)] + ([str(value - 1)] if value > 0 else [])
            else:
                options = [new for new in news if new != old]
            for new in options:
                yield change(match.start(), match.end(), new, f"{old.strip() or old} -> {new.strip() or new or 'nothing'}")

    for pattern, value in TERMS:
        for match in re.finditer(pattern, code):
            yield change(match.start(), match.end(), value, f"{match.group(0)} -> {value}")

    for match in STATEMENT.finditer(code):
        yield change(match.start(1), match.end(1), ";", f"without: {match.group(1)}")


def verdict(mutant: Mutant, sources: dict[str, str], folder: Path, compiler: str) -> str:
    for name, text in sources.items():
        (folder / name).write_text(mutant.text if name == mutant.file else text)
    binary = folder / "test"
    built = subprocess.run([compiler, "-std=c11", "-O0", "-w", f"-I{folder}", "-o", str(binary),
                            str(TEST), str(folder / FILES[0])],
                           capture_output=True, text=True)
    if built.returncode != 0:
        return "does not compile"
    try:
        ran = subprocess.run([str(binary)], stdout=subprocess.DEVNULL, timeout=RUN_SECONDS)
    except subprocess.TimeoutExpired:
        return "killed"
    return "killed" if ran.returncode != 0 else "survived"


def main() -> int:
    compiler = os.environ.get("CC", "cc")
    sources = {name: (SOURCE / name).read_text() for name in FILES}
    mutants = []
    seen = set()
    for name, text in sources.items():
        for mutant in mutants_of(name, text):
            if mutant.text not in seen and mutant.text != text:
                seen.add(mutant.text)
                mutants.append(mutant)

    counts = {"killed": 0, "survived": 0, "does not compile": 0, "means nothing": 0}
    survivors = []
    with tempfile.TemporaryDirectory() as folder:
        unchanged = Mutant(FILES[0], 0, "no change", sources[FILES[0]])
        if verdict(unchanged, sources, Path(folder), compiler) != "survived":
            print("the tests do not pass on the policy as it is")
            return 2

        for mutant in mutants:
            result = verdict(mutant, sources, Path(folder), compiler)
            line = mutant.text.splitlines()[mutant.line - 1].strip()
            if result == "survived" and (mutant.file, line) in MEANS_NOTHING:
                result = "means nothing"
            counts[result] += 1
            if result == "survived":
                survivors.append(mutant)
                print(f"SURVIVED {mutant.file}:{mutant.line}: {mutant.what}\n    {line}", flush=True)

    print(f"{len(mutants)} changes: {counts['killed']} killed, {counts['survived']} survived, "
          f"{counts['means nothing']} mean nothing, {counts['does not compile']} did not compile")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
