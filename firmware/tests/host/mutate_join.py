#!/usr/bin/env python3
"""Do the tests of the join policy notice when it is wrong?

    python3 firmware/tests/host/mutate_join.py

The same as mutate_stuck.py, whose engine this uses, for src/join_policy.c and src/join_policy.h
with test_join_policy.c. It stops with an error if a change survives that is not on the list below
of those that mean nothing, each with the reason.
"""

import re
import sys

import mutate_stuck as engine

engine.TEST = engine.HOST / "test_join_policy.c"
engine.FILES = ("join_policy.c", "join_policy.h")

# Changes that make no difference to what the policy decides, by file and the line as changed.
engine.MEANS_NOTHING = {
    # The two limits are told apart by the tests, and the first value of an enum has no meaning.
    ("join_policy.h", "JOIN_WAIT,"),
}

engine.REPLACEMENTS = [
    (r">=", ["<", ">"]),
    (r"(?<![-<>=!])<(?![=<])", [">=", "<="]),
    (r"==", ["!="]),
    (r"!=", ["=="]),
    (r"&&", ["||"]),
    (r"\|\|", ["&&"]),
    (r"!(?=[\w(])", [""]),
    (r"\btrue\b", ["false"]),
    (r"\bfalse\b", ["true"]),
    (r" - ", [" + "]),
    (r"(?<![\w.])\d+(?![\w.])", None),
    (r"JOIN_(WAIT|DISCONNECT|GAVE_UP|CONNECT)(?=[;\s,)])",
     ["JOIN_WAIT", "JOIN_DISCONNECT", "JOIN_GAVE_UP", "JOIN_CONNECT"]),
    (r"JOIN_(LEAVE_LIMIT|QUIET|FLIGHT|HOLD_LIMIT)_MS(?=[\s)])",
     ["JOIN_LEAVE_LIMIT_MS", "JOIN_QUIET_MS", "JOIN_FLIGHT_MS", "JOIN_HOLD_LIMIT_MS"]),
]

# A condition with one of its terms taken out: the term's value, as if it were never there.
engine.TERMS = [
    (r"join->leaving\b", "true"),
    (r"join->leaving\b", "false"),
    (r"!join->pending", "false"),
    (r"view->associated", "true"),
    (r"view->associated", "false"),
    (r"view->changed\b", "true"),
    (r"view->changed\b", "false"),
    (r"view->now_ms - join->leaving_since_ms < JOIN_LEAVE_LIMIT_MS", "true"),
    (r"view->now_ms - join->leaving_since_ms < JOIN_LEAVE_LIMIT_MS", "false"),
    (r"!view->changed\b", "true"),
    (r"!view->changed\b", "false"),
    (r"view->now_ms - view->changed_at_ms >= JOIN_QUIET_MS", "true"),
    (r"view->now_ms - view->changed_at_ms >= JOIN_QUIET_MS", "false"),
    (r"view->joining\b", "true"),
    (r"view->joining\b", "false"),
    (r"view->now_ms - view->joining_since_ms < JOIN_FLIGHT_MS", "true"),
    (r"view->now_ms - view->joining_since_ms < JOIN_FLIGHT_MS", "false"),
    (r"\bjoining\b(?! =)", "true"),
    (r"\bjoining\b(?! =)", "false"),
    (r"!join->retry", "true"),
    (r"!join->retry", "false"),
    (r"join->retry\b", "true"),
    (r"join->retry\b", "false"),
    (r"!join->pending", "true"),
    (r"!join->held", "true"),
    (r"!join->held", "false"),
    (r"view->now_ms - join->held_since_ms < JOIN_HOLD_LIMIT_MS", "true"),
    (r"view->now_ms - join->held_since_ms < JOIN_HOLD_LIMIT_MS", "false"),
]

# A statement on a line of its own, which is left out.
engine.STATEMENT = re.compile(r"^\s+((?:join[\w>.-]*(?:\s*=.*|\(.*\))|return JOIN_\w+);)\s*$", re.MULTILINE)

if __name__ == "__main__":
    sys.exit(engine.main())
