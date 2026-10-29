"""The calibration test catalogue: the shared tests in coach/assessments.json, merged with the
person's own adjustments in <data>/plans/calibration.json:

    {"tests":     {"<test id>": {field overrides, e.g. "load_kg", "how", "stop"} | a whole new test},
     "batteries": {"<battery id>": {"title", "duration", "coach_note", "warmup", "tests": [ids]}}}

Test ids are stable across people and retests; personal changes never rename a test.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from core import paths  # noqa: E402

PERSONAL = paths.PLANS / "calibration.json"


def load():
    cat = paths.read_json(paths.ASSESSMENTS, {"tests": {}, "batteries": {}})
    own = paths.read_json(PERSONAL, {}) or {}
    for tid, over in (own.get("tests") or {}).items():
        cat["tests"][tid] = {**cat["tests"].get(tid, {}), **over}
    cat["batteries"] = {**cat.get("batteries", {}), **(own.get("batteries") or {})}
    return cat


def load_steps():
    """Loads the person's equipment allows: {"barbell": [kg...], "dumbbell": [kg per dumbbell...]}.
    Set by the Coach in profile/equipment.json -> "load_steps" during onboarding."""
    eq = paths.read_json(paths.PROFILE / "equipment.json", {}) or {}
    steps = eq.get("load_steps") or {}
    return {k: sorted(float(x) for x in v) for k, v in steps.items() if isinstance(v, list)}
